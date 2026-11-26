import 'server-only';
import { env } from 'cloudflare:workers';
import { from_now, now, one, run } from './sql';
import { randomToken, sha256 } from './hash';
import { requireSelf } from './session';
import { auditStmt } from './audit';
import { batch, stmt } from './sql';
import { Conflict, Forbidden, Invalid } from './errors';

/**
 * Привязка Telegram агентом самостоятельно.
 *
 * Зачем. Раньше telegram_id проставлял админ: агент присылал ему номер,
 * тот вписывал. Это и работа для двоих, и дыра в проверке — админ верит,
 * что номер принадлежит приславшему, а убедиться нечем.
 *
 * Как теперь. Агент получает одноразовый код и открывает по ссылке бота.
 * Бот получает от Telegram НАСТОЯЩИЙ идентификатор отправителя и
 * привязывает его. Подделать нельзя: идентификатор приходит от Telegram,
 * а не от человека.
 *
 * Код живёт недолго и срабатывает один раз — как ссылка входа. Разница в
 * том, что вход даёт сессию, а здесь привязывается канал доставки, и
 * цена ошибки меньше; срок всё равно короткий: код уходит в чат, а чат
 * могут читать не только вы.
 */

/** Сколько живёт код привязки. */
const LINK_TTL_MS = 10 * 60 * 1000;

/** Сколько кодов можно запросить за час: защита от засорения таблицы. */
const PER_AGENT_PER_HOUR = 10;

/**
 * Ожидающему одобрения привязка РАЗРЕШЕНА — те же ворота, что у профиля.
 *
 * Напоминания нужны с первого дня работы, а одобрение может занять день.
 * Заблокированного не пускают: у него доступ отозван целиком.
 */

export type LinkStart = { url: string; expires_at: string };

/**
 * Завести код и собрать ссылку на бота.
 *
 * Имя бота — настройка, а не константа: бот у площадки может смениться, а
 * выкладка ради имени бота — лишний повод тронуть код. Не задано — честный
 * отказ, а не ссылка в никуда: по ссылке `t.me/?start=…` человек попадёт
 * на пустую страницу и решит, что сломались мы.
 */
export async function startTelegramLink(): Promise<LinkStart> {
  const agent = await requireSelf();

  const bot = ((env as unknown as { TELEGRAM_BOT_USERNAME?: string })
    .TELEGRAM_BOT_USERNAME ?? '').trim().replace(/^@/, '');
  if (!bot) {
    throw new Invalid('Бот не настроен: не задано TELEGRAM_BOT_USERNAME');
  }

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await one<{ n: number }>(
    'select count(*) as n from telegram_links where agent_id = ? and created_at > ?',
    agent.id, hourAgo,
  );
  if ((recent?.n ?? 0) >= PER_AGENT_PER_HOUR) {
    throw new Invalid('Слишком много попыток, попробуйте через час');
  }

  const code = randomToken();
  const at = now();
  const expires = from_now(LINK_TTL_MS);

  await run(
    `insert into telegram_links (code_hash, agent_id, created_at, expires_at)
     values (?, ?, ?, ?)`,
    await sha256(code), agent.id, at, expires,
  );

  return { url: `https://t.me/${bot}?start=${code}`, expires_at: expires };
}

/**
 * Применить код: привязать отправителя к агенту.
 *
 * Зовётся ТОЛЬКО из обработчика бота, и права здесь не проверяются — их
 * проверить нечем: запрос приходит от Telegram, а не от вошедшего
 * человека. Подлинность самого запроса обязан проверить обработчик по
 * секретному заголовку, ДО вызова этой функции.
 *
 * Код гасится тем же запросом, который его проверяет: два одновременных
 * перехода по одной ссылке иначе дали бы две привязки.
 */
export async function completeTelegramLink(
  code: string,
  telegramId: number,
): Promise<{ agent_id: string }> {
  const value = (code ?? '').trim();
  if (!value) throw new Forbidden('Код неполный');
  if (!Number.isInteger(telegramId) || telegramId <= 0) {
    throw new Invalid('Неверный идентификатор Telegram');
  }

  const hash = await sha256(value);
  const at = now();

  // Срок проверяется ЗДЕСЬ и ещё раз при гашении ниже, и это не описка.
  // Гашение — единственное, что держит одноразовость, и условие там
  // обязательно. Здесь же оно нужно для внятного отказа: без него
  // протухший код дошёл бы до проверки занятости и человек получил бы
  // «уже привязан к другому агенту» вместо «код протух».
  //
  // Следствие для мутаций: убрать условие из одного места прогон не
  // роняет — второе доделывает работу. Падает только снятие обоих, и это
  // проверено. Выживание такой мутации объяснимо, а не пробел в тестах.
  const link = await one<{ agent_id: string }>(
    `select agent_id from telegram_links
      where code_hash = ? and used_at is null and expires_at > ?`,
    hash, at,
  );
  if (!link) throw new Forbidden('Код недействителен или уже использован');

  // Один Telegram — один агент. Ограничение стоит и в схеме, но внятный
  // отказ лучше, чем ошибка базы: человек должен понять, что произошло.
  const taken = await one<{ id: string }>(
    'select id from agents where telegram_id = ? and id <> ?',
    telegramId, link.agent_id,
  );
  if (taken) throw new Conflict('Этот Telegram уже привязан к другому агенту');

  const used = await run(
    `update telegram_links set used_at = ?
      where code_hash = ? and used_at is null and expires_at > ?`,
    at, hash, at,
  );
  if (used === 0) throw new Forbidden('Код недействителен или уже использован');

  await batch([
    stmt('update agents set telegram_id = ?, updated_at = ? where id = ?',
      telegramId, at, link.agent_id),
    auditStmt('agents', link.agent_id, 'update', link.agent_id,
      { telegram_id: { from: null, to: telegramId } }),
  ]);

  return { agent_id: link.agent_id };
}

/**
 * Отвязать свой Telegram.
 *
 * Нужна не для красоты: человек меняет аккаунт, уходит из агентства или
 * просто не хочет напоминаний в личный чат. Без отвязки единственным
 * выходом был бы админ, то есть ровно то, от чего уходили.
 */
export async function unlinkTelegram(): Promise<void> {
  const agent = await requireSelf();
  const at = now();

  await batch([
    stmt('update agents set telegram_id = null, updated_at = ? where id = ?',
      at, agent.id),
    auditStmt('agents', agent.id, 'update', agent.id,
      { telegram_id: { from: agent.telegram_id, to: null } }),
  ]);
}

/** Уборка протухших кодов: без неё таблица растёт вечно. */
export async function sweepTelegramLinks(): Promise<number> {
  return run('delete from telegram_links where expires_at < ?', now());
}
