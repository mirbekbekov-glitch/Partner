import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Сессия кабинета.
 *
 * Своя, а не Supabase Auth, по одной причине: код в WhatsApp отправляем мы
 * сами (инвариант 18), значит и подтверждение номера происходит у нас. Из
 * подтверждённого номера собирается то же, что выдал бы Supabase: клеймы
 * `sub` и `phone`, которые база читает через `auth.uid()` и `auth.jwt()`.
 * Поэтому переход на Supabase Auth позже меняет только этот файл — база и
 * страницы не заметят.
 *
 * Куки подписаны, а не зашифрованы: внутри нет ничего тайного — идентификатор
 * и номер человек и так про себя знает. Подпись нужна, чтобы номер нельзя
 * было подменить на чужой, а это она и делает.
 */

const COOKIE = "partner_session";
const TTL_SECONDS = 60 * 60 * 24 * 30;

export type Session = {
  sub: string;
  phone: string;
  exp: number;
};

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error(
      "SESSION_SECRET не задан или короче 32 знаков. Это ключ подписи сессии: без него подделать вход тривиально. Смотрите web/.env.example.",
    );
  }
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function encode(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function decode(raw: string): Session | null {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const given = raw.slice(dot + 1);

  // Сравнение постоянного времени: иначе подпись подбирается по времени
  // ответа. Длины сначала, потому что timingSafeEqual требует равных.
  const expected = sign(payload);
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    if (!session.sub || !session.phone || !session.exp) return null;
    if (session.exp < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

export async function readSession(): Promise<Session | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  return raw ? decode(raw) : null;
}

export async function writeSession(sub: string, phone: string): Promise<void> {
  const session: Session = {
    sub,
    phone,
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };
  (await cookies()).set(COOKIE, encode(session), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** Ключ для генерации: выводится в подсказке, когда SESSION_SECRET не задан. */
export function suggestSecret(): string {
  return randomBytes(32).toString("base64url");
}
