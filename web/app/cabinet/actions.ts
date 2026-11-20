"use server";

import type { PoolClient } from "pg";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { asAgent, asAuthService } from "../../lib/db";
import { clearSession, readSession, writeSession } from "../../lib/session";
import { sendLoginCode, showsCodeOnScreen } from "../../lib/otp";

/**
 * Действия кабинета.
 *
 * Каждое — вызов функции базы, и больше ничего. Здесь нет ни одной проверки
 * прав, и это не упущение: проверки живут в функциях (`app.require_agent()`,
 * `app.is_admin()`, владелец мандата) и в построчных политиках. Проверка,
 * повторённая здесь, разошлась бы с базой при первой же правке — и разошлась
 * бы молча.
 *
 * Поэтому задача этого файла — передать ответ базы человеку словами, а не
 * решать, что ему можно.
 */

export type Result = { ok: true; message?: string } | { ok: false; error: string };

/** Сообщение базы человеку. Префиксы вида INVARIANT_9 нужны тесту, не людям. */
function humanize(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^INVARIANT_\d+:\s*/, "").replace(/^FORBIDDEN:\s*/, "");
}

/**
 * Действие, после которого строка меняет вид.
 *
 * Одобрили агента — и кнопка «Одобрить» исчезает вместе с формой, в которой
 * лежало сообщение об успехе. Получается, что действие сработало, а слов не
 * сказано. Поэтому успех таких действий уходит в адрес страницы и
 * показывается сверху: уведомление переживает перерисовку, потому что
 * рисуется сервером заново.
 *
 * Отказ при этом остаётся у кнопки: он относится к ней, а не к странице.
 */
async function actThenNotice(
  fn: (db: PoolClient) => Promise<string>,
  path: string,
): Promise<Result> {
  const result = await act(fn, path);
  if (!result.ok) return result;
  redirect(`${path}?note=${encodeURIComponent(result.message ?? "Готово.")}`);
}

async function act(
  fn: (db: PoolClient) => Promise<string | void>,
  path = "/cabinet",
): Promise<Result> {
  const session = await readSession();
  if (!session) return { ok: false, error: "Вход истёк. Войдите снова." };
  try {
    const message = await asAgent(session, "read write", fn);
    revalidatePath(path);
    return { ok: true, message: message ?? undefined };
  } catch (error) {
    return { ok: false, error: humanize(error) };
  }
}

// ---------------------------------------------------------------------------
// Вход
// ---------------------------------------------------------------------------

export async function requestCode(_prev: unknown, form: FormData): Promise<Result> {
  const phone = String(form.get("phone") ?? "").trim();
  if (!phone) return { ok: false, error: "Введите номер телефона." };

  try {
    const issued = await asAuthService(async (db) => {
      const { rows } = await db.query<{ code: string; phone: string }>(
        "select code, phone from app.issue_login_code($1)",
        [phone],
      );
      return rows[0];
    });

    await sendLoginCode(issued.phone, issued.code);

    return {
      ok: true,
      message: showsCodeOnScreen()
        ? `Код для ${issued.phone}: ${issued.code} — WhatsApp не подключён, это режим разработки`
        : `Код отправлен в WhatsApp на ${issued.phone}`,
    };
  } catch (error) {
    return { ok: false, error: humanize(error) };
  }
}

export async function submitCode(_prev: unknown, form: FormData): Promise<Result> {
  const phone = String(form.get("phone") ?? "").trim();
  const code = String(form.get("code") ?? "").trim();
  const fullName = String(form.get("full_name") ?? "").trim();

  try {
    const verified = await asAuthService(async (db) => {
      const { rows } = await db.query<{
        ok: boolean;
        reason: string | null;
        auth_user_id: string | null;
        phone: string;
      }>("select ok, reason, auth_user_id, phone from app.verify_login_code($1, $2)", [
        phone,
        code,
      ]);
      return rows[0];
    });

    // Неудачный вход база возвращает ответом, а не исключением: исключение
    // откатило бы счётчик попыток (инвариант 18).
    if (!verified?.ok || !verified.auth_user_id) {
      return { ok: false, error: verified?.reason ?? "Код не принят." };
    }

    // Вход создаёт агента или обновляет существующего. Новому ставится
    // «ожидает одобрения» — это инвариант 17, а не решение этой страницы.
    const uid = verified.auth_user_id;
    await asAuthService(async (db) => {
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: uid, phone: verified.phone, role: "authenticated" }),
      ]);
      await db.query("select app.login_by_phone($1)", [fullName || null]);
    });

    await writeSession(uid, verified.phone);
  } catch (error) {
    return { ok: false, error: humanize(error) };
  }

  redirect("/cabinet");
}

export async function logout(): Promise<void> {
  await clearSession();
  redirect("/cabinet/login");
}

// ---------------------------------------------------------------------------
// Объекты
// ---------------------------------------------------------------------------

export async function confirmActual(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("object_id"));
  return act(async (db) => {
    await db.query("select app.confirm_actual($1)", [id]);
    return "Актуальность подтверждена.";
  }, "/cabinet/objects");
}

export async function publish(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("object_id"));
  return act(async (db) => {
    await db.query("select publish_object($1)", [id]);
    return "Объект в каталоге.";
  }, "/cabinet/objects");
}

export async function withdraw(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("object_id"));
  return act(async (db) => {
    await db.query("select withdraw_object($1)", [id]);
    return "Объект снят с публикации.";
  }, "/cabinet/objects");
}

export async function issueOwnerLink(_prev: unknown, form: FormData): Promise<Result> {
  const objectId = String(form.get("object_id"));
  const contactId = String(form.get("contact_id"));
  const days = Number(form.get("days") ?? 30);
  return act(async (db) => {
    const { rows } = await db.query<{ token: string }>(
      "select token from issue_owner_access($1, $2, $3)",
      [objectId, contactId, days],
    );
    return `${process.env.SITE_URL ?? ""}/report/${rows[0].token}`;
  }, `/cabinet/objects/${objectId}`);
}

// ---------------------------------------------------------------------------
// Обращения
// ---------------------------------------------------------------------------

export async function qualifyInquiry(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("inquiry_id"));
  return act(async (db) => {
    await db.query("select qualify_inquiry($1)", [id]);
    return "Обращение взято в работу.";
  }, "/cabinet/inquiries");
}

export async function rejectInquiry(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("inquiry_id"));
  const reason = String(form.get("reason") ?? "").trim();
  const spam = form.get("spam") === "on";
  return act(async (db) => {
    await db.query("select reject_inquiry($1, $2, $3)", [id, reason || null, spam]);
    return spam ? "Отмечено спамом." : "Отказ зафиксирован.";
  }, "/cabinet/inquiries");
}

// ---------------------------------------------------------------------------
// Кандидаты с площадок
// ---------------------------------------------------------------------------

export async function claimCandidate(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("candidate_id"));
  const days = Number(form.get("days") ?? 3);
  return act(async (db) => {
    await db.query("select claim_candidate($1, $2)", [id, days]);
    return "Закреплено за вами. Телефон теперь виден — если он вообще есть.";
  }, "/cabinet/candidates");
}

export async function releaseCandidate(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("candidate_id"));
  return act(async (db) => {
    await db.query("select release_candidate($1)", [id]);
    return "Возвращено в пул.";
  }, "/cabinet/candidates");
}

export async function rejectCandidate(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("candidate_id"));
  const reason = String(form.get("reason") ?? "").trim();
  return act(async (db) => {
    await db.query("select reject_candidate($1, $2)", [id, reason || null]);
    return "Отказ зафиксирован: в очереди это объявление больше не появится.";
  }, "/cabinet/candidates");
}

// ---------------------------------------------------------------------------
// Администратор
// ---------------------------------------------------------------------------

export async function approveAgent(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("agent_id"));
  return actThenNotice(async (db) => {
    const { rows } = await db.query<{ full_name: string }>(
      "select full_name from approve_agent($1)",
      [id],
    );
    return `${rows[0].full_name} одобрен и может работать.`;
  }, "/cabinet/agents");
}

export async function blockAgent(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("agent_id"));
  return actThenNotice(async (db) => {
    const { rows } = await db.query<{ full_name: string }>(
      "select full_name from block_agent($1)",
      [id],
    );
    return `${rows[0].full_name} заблокирован.`;
  }, "/cabinet/agents");
}

export async function setAgentRole(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("agent_id"));
  const role = String(form.get("role"));
  return actThenNotice(async (db) => {
    const { rows } = await db.query<{ full_name: string; role: string }>(
      "select full_name, role::text as role from set_agent_role($1, $2::agent_role)",
      [id, role],
    );
    return `${rows[0].full_name}: роль «${rows[0].role === "admin" ? "администратор" : "агент"}».`;
  }, "/cabinet/agents");
}

export async function runMaintenance(_prev: unknown, form: FormData): Promise<Result> {
  const job = String(form.get("job") ?? "") || null;
  return act(async (db) => {
    const { rows } = await db.query<{ job: string; ok: boolean; error: string | null }>(
      "select job, ok, error from run_maintenance_now($1)",
      [job],
    );
    const failed = rows.filter((r) => !r.ok);
    if (failed.length > 0) {
      return `С ошибками: ${failed.map((f) => `${f.job} — ${f.error}`).join("; ")}`;
    }
    return `Выполнено: ${rows.map((r) => r.job).join(", ")}.`;
  }, "/cabinet/scheduler");
}

export async function updateMyName(_prev: unknown, form: FormData): Promise<Result> {
  const name = String(form.get("full_name") ?? "").trim();
  if (!name) return { ok: false, error: "Имя не может быть пустым." };
  return act(async (db) => {
    // Агенту разрешены ровно два столбца: имя и Telegram (инвариант 17).
    await db.query("update agents set full_name = $1 where auth_user_id = auth.uid()", [name]);
    return "Имя изменено.";
  }, "/cabinet/profile");
}
