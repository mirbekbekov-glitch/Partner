import 'server-only';
import { batch, from_now, now, one, stmt } from './sql';
import { randomToken, sha256 } from './hash';
import { ensureAgentByEmail } from './agents';
import { auditStmt } from './audit';
import { requireAdmin } from './session';
import { Forbidden, Invalid } from './errors';

/**
 * Приглашение агента ссылкой, которую передаёт админ.
 *
 * Зачем это понадобилось. Вход устроен письмом со ссылкой, а на бесплатном
 * плане Workers письмо уходит ТОЛЬКО на заранее подтверждённый адрес.
 * Адрес нового агента никто заранее не подтверждал, значит до сих пор
 * завести второго человека было нельзя вовсе: форма входа отвечает
 * «письмо отправлено» — она обязана отвечать одинаково всем, — и письмо не
 * приходит. Снаружи это выглядит как поломка сайта, а не как ограничение
 * плана.
 *
 * Агентство заводит людей через WhatsApp, и ссылка идёт тем же путём:
 * админ выдаёт её в кабинете и передаёт сам. Почта при этом остаётся
 * ключом учётной записи — меняется только способ доставки первой ссылки.
 *
 * Чем это НЕ является. Это не вход за агента и не способ посмотреть его
 * кабинет: ссылка одноразовая, и кто по ней прошёл — тот и стал этим
 * агентом. Но ссылку держит в руках админ, и это честно надо сказать:
 * выдавший её может войти вместо приглашённого. Поэтому выдача
 * записывается в журнал с именем выдавшего, а не происходит анонимно, и
 * поэтому срок у неё сутки, а не месяц.
 */

/**
 * Сутки.
 *
 * У обычного входа пятнадцать минут: человек сам нажал «войти» и смотрит в
 * ящик. Здесь ссылку надо переслать, а получатель может спать или быть в
 * другом часовом поясе. Пятнадцать минут означали бы, что половина
 * приглашений протухает в переписке, и админ выдаёт их по второму разу —
 * то есть ссылок становится больше, а не меньше.
 */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** Простейшая проверка формы адреса — та же, что у входа. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export type Invite = {
  /** Полная ссылка. Показывается ОДИН раз: в базе лежит только хэш. */
  link: string;
  email: string;
  full_name: string;
  /** Агент уже числился — значит это повторная выдача, а не новый человек. */
  existed: boolean;
  expires_at: string;
};

export type InviteInput = {
  email: string;
  full_name?: string | null;
  /** Полный адрес сайта: ссылка обязана быть абсолютной, её пересылают. */
  origin: string;
};

/**
 * Выдать приглашение. Только админ.
 *
 * Учётная запись заводится СРАЗУ, не при первом входе: админ видит
 * приглашённого в списке агентов и может одобрить его заранее. Иначе
 * человек проходит по ссылке и попадает на экран «ждите одобрения», а
 * админ узнаёт об этом из его звонка.
 */
export async function inviteAgent(input: InviteInput): Promise<Invite> {
  const admin = await requireAdmin();

  const email = (input.email ?? '').trim().toLowerCase();
  if (!looksLikeEmail(email)) throw new Invalid('Это не похоже на адрес почты');

  const name = (input.full_name ?? '').trim();

  const before = await one<{ id: string }>('select id from agents where email = ?', email);
  const agent = await ensureAgentByEmail(email, name || null);

  // Заблокированному ссылка не выдаётся. Вход ему всё равно откажет — но
  // отказать надо ЗДЕСЬ: иначе админ отправляет ссылку, человек по ней
  // приходит и видит «доступ закрыт», а выглядит это так, будто доступ
  // закрылся только что. Разблокировка — отдельное осознанное действие,
  // а не побочный смысл приглашения.
  if (agent.status === 'blocked') {
    throw new Forbidden('Этому агенту доступ закрыт. Сначала снимите блокировку');
  }

  const token = randomToken();
  const at = now();
  const expires = from_now(INVITE_TTL_MS);

  await batch([
    stmt(
      `insert into login_tokens
         (token_hash, email, created_at, expires_at, redirect_to, issued_by_agent_id)
       values (?, ?, ?, ?, ?, ?)`,
      await sha256(token), email, at, expires, '/cabinet', admin.id,
    ),
    // Журнал пишется В ТОМ ЖЕ батче, что и сама выдача: батч D1 —
    // транзакция, поэтому ссылка без записи о том, кто её выдал, не
    // сохранится в принципе.
    auditStmt('agent_invite', agent.id, 'insert', admin.id, {
      email: { from: null, to: email },
      expires_at: { from: null, to: expires },
    }),
  ]);

  return {
    link: `${input.origin.replace(/\/$/, '')}/auth/enter?token=${token}`,
    email,
    full_name: agent.full_name,
    existed: Boolean(before),
    expires_at: expires,
  };
}
