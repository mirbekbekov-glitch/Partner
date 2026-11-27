import 'server-only';
import { batch, from_now, now, one, run, stmt } from './sql';
import { randomToken, sha256 } from './hash';
import { ensureAgentByEmail } from './agents';
// Через «@/», а не «./email», намеренно: это шов. Отправка писем — единственное
// место слоя входа, которое нельзя выполнить вне Worker, и прогон подменяет
// ровно этот модуль. Относительный импорт подменить нечем, и шов был бы
// невидим в коде.
import { sendMail } from '@/lib/db/email';
import { LOGIN_TTL_MS, startSession, type Agent } from './session';
import { Forbidden, Invalid } from './errors';

/**
 * Вход по ссылке на почту — замена Supabase Auth.
 *
 * Как устроено. Человек вводит почту → в базу кладётся ХЭШ одноразового
 * токена, сам токен уходит письмом → переход по ссылке обменивает токен на
 * сессию. Токен существует ровно в одном месте — в письме; в базе лежит
 * только SHA-256, поэтому утечка таблицы входа не даёт войти.
 *
 * Чего здесь намеренно нет.
 *
 * Пароля нет: его забывают, повторяют с других сайтов и восстанавливают
 * через ту же почту — то есть почта всё равно остаётся ключом, только с
 * лишним звеном.
 *
 * Ответ на запрос входа ОДИНАКОВ для известной и неизвестной почты. Иначе
 * форма входа превращается в проверку «есть ли такой агент», а список
 * сотрудников агентства — не публичные данные.
 */

/** Сколько запросов входа с одной почты в час. */
const PER_EMAIL_PER_HOUR = 5;

/** Куда вести после входа, если не сказано иного. */
const DEFAULT_REDIRECT = '/cabinet';

/**
 * Куда можно возвращать после входа.
 *
 * Только собственные пути сайта. Без этой проверки ссылка из письма
 * становится открытым перенаправлением: «войдите» ведёт на чужой сайт,
 * похожий на наш.
 */
function safeRedirect(target: string | null | undefined): string {
  const value = (target ?? '').trim();
  if (!value.startsWith('/')) return DEFAULT_REDIRECT;
  // «//злой.сайт» браузер читает как внешний адрес.
  if (value.startsWith('//')) return DEFAULT_REDIRECT;
  return value;
}

/** Простейшая проверка формы адреса. Существование проверит само письмо. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export type LoginRequest = {
  email: string;
  redirect_to?: string | null;
  /** Полный адрес сайта: ссылка в письме обязана быть абсолютной. */
  origin: string;
};

/**
 * Запросить вход: завести одноразовый токен и отправить письмо.
 *
 * Возвращает всегда одно и то же — см. пояснение выше про одинаковый
 * ответ. Исключение бросается только тогда, когда виноваты мы: отправка не
 * настроена или почта введена с ошибкой формы.
 */
export async function requestLogin(input: LoginRequest): Promise<void> {
  const email = input.email.trim().toLowerCase();

  if (!looksLikeEmail(email)) throw new Invalid('Это не похоже на адрес почты');

  // Частота: перебор адресов и заваливание чужого ящика письмами.
  //
  // Выданные админом приглашения в этот счёт НЕ идут. Предел стоит против
  // того, кто жмёт «войти» снаружи без спроса; выдача админа — осознанное
  // действие, записанное в журнал. Если считать и её, пять приглашений
  // подряд закрывали бы самому агенту вход на час — то есть лимит бил бы
  // по тому, кого защищает.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await one<{ n: number }>(
    `select count(*) as n from login_tokens
      where email = ? and created_at > ? and issued_by_agent_id is null`,
    email, hourAgo,
  );
  if ((recent?.n ?? 0) >= PER_EMAIL_PER_HOUR) {
    throw new Invalid('Слишком много попыток входа, попробуйте через час');
  }

  const token = randomToken();
  const at = now();
  const redirect = safeRedirect(input.redirect_to);

  await run(
    `insert into login_tokens (token_hash, email, created_at, expires_at, redirect_to)
     values (?, ?, ?, ?, ?)`,
    await sha256(token), email, at, from_now(LOGIN_TTL_MS), redirect,
  );

  const link = `${input.origin.replace(/\/$/, '')}/auth/enter?token=${token}`;
  const minutes = Math.round(LOGIN_TTL_MS / 60000);

  // Письмо нарочно короткое и без картинок: оно служебное, его читают
  // десять секунд. Срок указан прямо — иначе протухшая ссылка выглядит
  // поломкой сайта.
  await sendMail({
    to: email,
    subject: 'Вход в кабинет Liberterra',
    text:
      `Ссылка для входа в кабинет:\n\n${link}\n\n`
      + `Она действует ${minutes} минут и срабатывает один раз.\n\n`
      + 'Если вход запрашивали не вы — просто не переходите по ссылке, '
      + 'ничего не произойдёт.',
    html:
      `<p>Ссылка для входа в кабинет:</p>`
      + `<p><a href="${link}">Войти в кабинет</a></p>`
      + `<p>Она действует ${minutes} минут и срабатывает один раз.</p>`
      + `<p>Если вход запрашивали не вы — просто не переходите по ссылке, `
      + `ничего не произойдёт.</p>`,
  });
}

export type LoginResult = { agent: Agent; redirect_to: string };

/**
 * Обменять токен из ссылки на сессию.
 *
 * Токен одноразовый: отметка об использовании ставится ТЕМ ЖЕ запросом,
 * который его проверяет (`update … where used_at is null`), и если строк
 * изменилось ноль — значит ссылку уже использовали. Проверить, а потом
 * отметить двумя действиями нельзя: два одновременных перехода по одной
 * ссылке дали бы две сессии.
 */
export async function completeLogin(token: string): Promise<LoginResult> {
  const value = (token ?? '').trim();
  if (!value) throw new Forbidden('Ссылка неполная');

  const hash = await sha256(value);
  const at = now();

  // Гасим и проверяем одним действием.
  const used = await run(
    `update login_tokens set used_at = ?
      where token_hash = ? and used_at is null and expires_at > ?`,
    at, hash, at,
  );

  if (used === 0) {
    // Истёкшая, уже использованная и несуществующая ссылка отвечают
    // одинаково: по разнице ответов перебираются чужие ссылки.
    throw new Forbidden('Ссылка недействительна или уже использована');
  }

  const row = await one<{ email: string; redirect_to: string | null }>(
    'select email, redirect_to from login_tokens where token_hash = ?', hash,
  );
  if (!row) throw new Forbidden('Ссылка недействительна');

  // Агент заводится при первом входе — в статусе «ожидает».
  const agent = await ensureAgentByEmail(row.email);

  if (agent.status === 'blocked') {
    throw new Forbidden('Доступ закрыт. Обратитесь к администратору');
  }

  await startSession(agent.id);

  return { agent, redirect_to: safeRedirect(row.redirect_to) };
}

/**
 * Погасить все прочие ссылки этой почты.
 *
 * Вызывается после успешного входа: человек вошёл, остальные письма со
 * ссылками больше не нужны и только расширяют окно для чужого перехода.
 */
export async function revokePendingLinks(email: string): Promise<number> {
  return run(
    `update login_tokens set used_at = ?
      where email = ? and used_at is null`,
    now(), email.trim().toLowerCase(),
  );
}

export { batch, stmt, safeRedirect };
