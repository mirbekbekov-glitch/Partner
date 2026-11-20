"use server";

import type { PoolClient } from "pg";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { asAgent, asAuthService } from "../../lib/db";
import { clearSession, readSession, writeSession } from "../../lib/session";
import { sendLoginCode, showsCodeOnScreen } from "../../lib/otp";
import { remove as removePhotoFile, save as savePhotoFile } from "../../lib/photos";

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
 * Действие, после которого строка меняет вид или переезжает.
 *
 * Одобрили агента — кнопка «Одобрить» исчезает вместе с формой, в которой
 * лежало сообщение об успехе. Взяли объявление в работу — строка переехала
 * из «Свободных» в «В работе у вас», и форма исчезла вместе с разделом.
 * Действие срабатывает, а слов не сказано.
 *
 * Поэтому успех таких действий уходит в адрес страницы и показывается
 * сверху: уведомление рисуется сервером заново и переживает перерисовку.
 * Отказ остаётся у кнопки — он относится к ней, а не к странице.
 *
 * Правило простое: меняется ли после действия НАБОР кнопок у этой строки.
 * Если да — уведомление сверху. Если нет (подтвердить актуальность, сменить
 * имя) — ответ у кнопки, там он нагляднее.
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
// Создание объекта
// ---------------------------------------------------------------------------

/**
 * Объект, собственник и договор заводятся одним вызовом.
 *
 * Здесь не собирается «объект, потом владелец, потом мандат»: база такой
 * сборки и не позволит — прямая вставка объекта роли приложения не выдана
 * (инвариант 19). Три вещи, которые в жизни происходят одним разговором с
 * собственником, и в базе происходят одним действием.
 */
export async function createObject(_prev: unknown, form: FormData): Promise<Result> {
  const text = (name: string) => {
    const value = String(form.get(name) ?? "").trim();
    return value === "" ? null : value;
  };
  const num = (name: string) => {
    const value = text(name);
    if (value === null) return null;
    const n = Number(value.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };

  const session = await readSession();
  if (!session) return { ok: false, error: "Вход истёк. Войдите снова." };

  let objectId: string;
  try {
    objectId = await asAgent(session, "read write", async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `select id from create_object(
           $1::object_kind, $2::deal_type, $3, $4::numeric,
           p_contact_id         => $5::uuid,
           p_owner_name         => $6,
           p_owner_phone        => $7,
           p_mandate_kind       => $8::mandate_kind,
           p_valid_to           => $9::date,
           p_contract_confirmed => $10::boolean,
           p_zone               => $11,
           p_rooms              => $12::smallint,
           p_area               => $13::numeric,
           p_floor              => $14::smallint,
           p_floors_total       => $15::smallint,
           p_currency           => $16,
           p_description        => $17,
           p_candidate_id       => $18::uuid)`,
        [
          text("kind"), text("deal_type"), text("address"), num("price"),
          text("contact_id"), text("owner_name"), text("owner_phone"),
          text("mandate_kind") ?? "non_exclusive",
          text("valid_to"), form.get("contract_confirmed") === "on",
          text("zone"), num("rooms"), num("area"), num("floor"), num("floors_total"),
          text("currency") ?? "USD", text("description"), text("candidate_id"),
        ],
      );
      return rows[0].id;
    });
  } catch (error) {
    return { ok: false, error: humanize(error) };
  }

  revalidatePath("/cabinet/objects");
  // Сразу в карточку: дальше агент добавляет фотографии, а они живут там.
  redirect(`/cabinet/objects/${objectId}?note=${encodeURIComponent("Объект заведён вместе с договором. Добавьте фотографии.")}`);
}

// ---------------------------------------------------------------------------
// Фотографии
// ---------------------------------------------------------------------------

/**
 * Загрузка фотографий.
 *
 * Порядок здесь важен и выбран сознательно: СНАЧАЛА файл в хранилище, ПОТОМ
 * запись в базе. При обратном порядке упавшая запись файла оставила бы
 * строку, указывающую в пустоту, — и каталог показывал бы битую картинку.
 * При этом порядке упавшая запись в базе оставляет файл, на который никто не
 * ссылается: он не виден нигде, потому что отдача идёт по записи в базе, а
 * не по содержимому каталога. Поэтому файл тут же убирается.
 *
 * Файлы обрабатываются по одному, а не пачкой в одной транзакции: агент
 * выбирает двадцать снимков с телефона, и падение на девятнадцатом не должно
 * отменять восемнадцать удачных.
 */
export async function uploadPhotos(_prev: unknown, form: FormData): Promise<Result> {
  const objectId = String(form.get("object_id"));
  const files = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);

  if (files.length === 0) return { ok: false, error: "Файлы не выбраны." };

  const session = await readSession();
  if (!session) return { ok: false, error: "Вход истёк. Войдите снова." };

  const added: string[] = [];
  const failed: string[] = [];

  for (const file of files) {
    let stored;
    try {
      stored = await savePhotoFile(objectId, file);
    } catch (error) {
      failed.push(`${file.name}: ${humanize(error)}`);
      continue;
    }

    try {
      await asAgent(session, "read write", async (db) => {
        await db.query(
          "select attach_photo($1, $2, $3, $4, $5, $6)",
          [objectId, stored.storageKey, stored.contentType,
           stored.width, stored.height, stored.byteSize],
        );
      });
      added.push(stored.storageKey);
    } catch (error) {
      // База отказала — файл в хранилище не нужен.
      await removePhotoFile(stored.storageKey);
      failed.push(`${file.name}: ${humanize(error)}`);
    }
  }

  revalidatePath(`/cabinet/objects/${objectId}`);

  if (added.length === 0) {
    return { ok: false, error: failed.join("; ") };
  }
  const word = added.length === 1 ? "фотография" : added.length < 5 ? "фотографии" : "фотографий";
  return {
    ok: true,
    message:
      `Добавлено ${added.length} ${word}.` +
      (failed.length > 0 ? ` Не вышло: ${failed.join("; ")}` : ""),
  };
}

export async function deletePhoto(_prev: unknown, form: FormData): Promise<Result> {
  const objectId = String(form.get("object_id"));
  const key = String(form.get("storage_key"));

  const result = await act(async (db) => {
    const { rows } = await db.query<{ delete_photo: string }>(
      "select delete_photo($1, $2)",
      [objectId, key],
    );
    return rows[0].delete_photo;
  }, `/cabinet/objects/${objectId}`);

  // Файл убирается только после того, как база согласилась: иначе отказ в
  // правах уносил бы чужую фотографию.
  if (!result.ok) return result;
  await removePhotoFile(key);

  // Успех уходит в адрес страницы: карточка фотографии исчезает вместе с
  // формой, в которой лежало сообщение, и действие срабатывало бы молча.
  redirect(`/cabinet/objects/${objectId}?note=${encodeURIComponent("Фотография удалена.")}`);
}

export async function setCover(_prev: unknown, form: FormData): Promise<Result> {
  const objectId = String(form.get("object_id"));
  const key = String(form.get("storage_key"));
  // Та же причина, что у удаления: после смены обложки кнопка «На обложку»
  // у этой фотографии исчезает.
  return actThenNotice(async (db) => {
    await db.query("select set_cover($1, $2)", [objectId, key]);
    return "Обложка изменена.";
  }, `/cabinet/objects/${objectId}`);
}

export async function movePhoto(_prev: unknown, form: FormData): Promise<Result> {
  const objectId = String(form.get("object_id"));
  const key = String(form.get("storage_key"));
  const direction = String(form.get("direction")) === "up" ? -1 : 1;

  return actThenNotice(async (db) => {
    const { rows } = await db.query<{ storage_key: string }>(
      "select storage_key from object_photos where object_id = $1 order by sort_order",
      [objectId],
    );
    const keys = rows.map((r) => r.storage_key);
    const from = keys.indexOf(key);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= keys.length) return "Двигать некуда.";

    [keys[from], keys[to]] = [keys[to], keys[from]];
    // Перечисляются ВСЕ ключи: частичный список поменял бы обложку
    // незаметно, и база такой вызов не примет.
    await db.query("select reorder_photos($1, $2::text[])", [objectId, keys]);
    return "Порядок изменён.";
  }, `/cabinet/objects/${objectId}`);
}

// ---------------------------------------------------------------------------
// Обращения
// ---------------------------------------------------------------------------

export async function qualifyInquiry(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("inquiry_id"));
  return actThenNotice(async (db) => {
    await db.query("select qualify_inquiry($1)", [id]);
    return "Обращение взято в работу.";
  }, "/cabinet/inquiries");
}

export async function rejectInquiry(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("inquiry_id"));
  const reason = String(form.get("reason") ?? "").trim();
  const spam = form.get("spam") === "on";
  return actThenNotice(async (db) => {
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
  return actThenNotice(async (db) => {
    await db.query("select claim_candidate($1, $2)", [id, days]);
    return "Закреплено за вами. Телефон теперь виден — если он вообще есть.";
  }, "/cabinet/candidates");
}

export async function releaseCandidate(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("candidate_id"));
  return actThenNotice(async (db) => {
    await db.query("select release_candidate($1)", [id]);
    return "Возвращено в пул.";
  }, "/cabinet/candidates");
}

export async function rejectCandidate(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("candidate_id"));
  const reason = String(form.get("reason") ?? "").trim();
  return actThenNotice(async (db) => {
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
