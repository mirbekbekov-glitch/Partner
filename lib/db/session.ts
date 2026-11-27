import 'server-only';
import { cookies } from 'next/headers';
import { all, flag, from_now, now, one, run, stmt, batch } from './sql';
import { randomToken, sha256 } from './hash';
import { Forbidden } from './errors';

/**
 * Кто сейчас работает.
 *
 * Раньше это решала Supabase Auth: JWT в cookie, auth.uid() внутри базы,
 * политики поверх него. Теперь вход наш, и ответ на вопрос «кто это»
 * даётся здесь — один раз на запрос.
 *
 * Сессия — случайный токен в cookie; в базе лежит только его SHA-256.
 * Поэтому список сессий можно показать агенту, не рискуя ничем: войти по
 * строке из таблицы нельзя.
 */

/** Имя cookie сессии. */
export const SESSION_COOKIE = 'lt_session';

/** Сколько живёт сессия. Тридцать суток: агент не должен входить каждый день. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Сколько живёт ссылка из письма. Пятнадцать минут — как было у Supabase. */
export const LOGIN_TTL_MS = 15 * 60 * 1000;

export type Agent = {
  id: string;
  email: string | null;
  telegram_id: number | null;
  works_since: number | null;
  certificate_no: string | null;
  certificate_confirmed: number;
  avatar_key: string | null;
  full_name: string;
  /** Имя в сопоставимом виде: по нему идёт порядок в списках. */
  name_sort: string;
  phone: string | null;
  /** На номере есть WhatsApp — со слов агента: проверить это нельзя. */
  whatsapp: number;
  /** Ник в Telegram, без «@». Ссылка собирается из него при показе. */
  telegram_user: string | null;
  role: 'agent' | 'admin';
  status: 'pending' | 'approved' | 'blocked';
  focus: 'sale' | 'rent' | 'both';
  organization_id: string | null;
  org_confirmed: number;
  created_at: string;
  updated_at: string;
};

/**
 * Агент этого запроса — любой, в каком бы он ни был статусе.
 *
 * Нужен страницам входа и ожидания одобрения: человек вошёл, но CRM ему
 * ещё не открыта, и сказать ему об этом можно только зная, кто он.
 */
export async function sessionAgent(): Promise<Agent | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const agent = await one<Agent>(
    `select a.* from sessions s
       join agents a on a.id = s.agent_id
      where s.token_hash = ? and s.expires_at > ?`,
    await sha256(token), now(),
  );

  return agent;
}

/**
 * Агент, которому открыта CRM. Это перенос app.current_agent_id().
 *
 * Статус «одобрен» проверяется здесь, а не на странице: забытая проверка на
 * одной странице открыла бы кабинет кому угодно.
 */
export async function currentAgent(): Promise<Agent | null> {
  const agent = await sessionAgent();
  return agent && agent.status === 'approved' ? agent : null;
}

/** Перенос app.require_agent(): без одобренного агента дальше хода нет. */
export async function requireAgent(): Promise<Agent> {
  const agent = await currentAgent();
  if (!agent) throw new Forbidden('Требуется одобренный агент');
  return agent;
}

/**
 * Агент правит СВОЮ карточку: имя, телефон, агентство.
 *
 * Отдельные ворота, слабее requireAgent, и вот зачем. Ожидающий одобрения
 * ещё не допущен к CRM — но именно ему нужно вписать имя, потому что админ
 * видит в списке заявок одну строку и по почте не поймёт, кто её подал.
 * Страница ожидания эту форму и показывает.
 *
 * Сперва форма звала requireAgent и потому не работала НИКОГДА: ожидающий
 * получал «Требуется одобренный агент» на странице, которая прямо звала
 * заполнить всё, не дожидаясь одобрения. Нашлось это только живым входом
 * с настоящей почты — ни один тест сюда не заглядывал.
 *
 * Заблокированного не пускаем: у него доступ отозван, и правка своей
 * карточки — тоже действие в системе.
 *
 * Эти ворота открывают РОВНО правку собственных полей. Роль, статус и
 * почту updateProfile не принимает вовсе, так что ослабления прав здесь
 * нет: пропускается тот же человек, только раньше.
 */
export async function requireSelf(): Promise<Agent> {
  const agent = await sessionAgent();
  if (!agent) throw new Forbidden('Нужно войти');
  if (agent.status === 'blocked') throw new Forbidden('Доступ закрыт администратором');
  return agent;
}

/** Перенос app.is_admin(). */
export async function isAdmin(): Promise<boolean> {
  const agent = await currentAgent();
  return agent?.role === 'admin';
}

/** Действие только для админа. */
export async function requireAdmin(): Promise<Agent> {
  const agent = await requireAgent();
  if (agent.role !== 'admin') throw new Forbidden('Действие доступно только админу');
  return agent;
}

// ---------------------------------------------------------------------------
// Выдача и снятие сессии
// ---------------------------------------------------------------------------

/**
 * Завести сессию и положить cookie.
 *
 * httpOnly — чтобы её не достал скрипт на странице; secure и SameSite=Lax —
 * чтобы она не уехала по чужой ссылке. Lax, а не Strict: по ссылке из
 * письма человек должен попадать в кабинет уже вошедшим.
 */
export async function startSession(agentId: string): Promise<void> {
  const token = randomToken();
  const at = now();

  await run(
    `insert into sessions (token_hash, agent_id, created_at, expires_at, seen_at)
     values (?, ?, ?, ?, ?)`,
    await sha256(token), agentId, at, from_now(SESSION_TTL_MS), at,
  );

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Выход: сессия удаляется и из базы, и из браузера. */
export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;

  if (token) {
    await run('delete from sessions where token_hash = ?', await sha256(token));
  }
  jar.delete(SESSION_COOKIE);
}

/**
 * Уборка просроченного.
 *
 * Вызывается расписанием. Без неё таблицы растут вечно, а просроченные
 * строки всё равно не дают войти — проверка по expires_at стоит в запросе.
 */
export async function sweepExpired(): Promise<{ sessions: number; tokens: number }> {
  const at = now();
  return {
    sessions: await run('delete from sessions where expires_at < ?', at),
    tokens: await run('delete from login_tokens where expires_at < ?', at),
  };
}

/** Сессии агента — для страницы профиля. Токенов здесь нет, только хэши. */
export async function agentSessions(agentId: string) {
  return all<{ created_at: string; seen_at: string; expires_at: string }>(
    `select created_at, seen_at, expires_at from sessions
      where agent_id = ? and expires_at > ? order by seen_at desc`,
    agentId, now(),
  );
}

export { batch, flag, stmt };
