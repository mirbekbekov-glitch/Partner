"use server";

import type { PoolClient } from "pg";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { asAgent, asAuthService } from "../../lib/db";
import { clearSession, readSession, writeSession } from "../../lib/session";
import { channel, sendLoginCode, showsCodeOnScreen } from "../../lib/otp";
import {
  remove as removePhotoFile,
  save as savePhotoFile,
  saveAvatar as saveAvatarFile,
} from "../../lib/photos";

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
  // Разделитель выбирается по пути, а не ставится всегда «?». На экране
  // воронки объектов путь уже содержал «?deal=sale», и получалось
  // «...?deal=sale?note=...» — браузер уходил в никуда, а действие при этом
  // срабатывало. Нашлось проходом в браузере.
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}note=${encodeURIComponent(result.message ?? "Готово.")}`);
}

/**
 * Куда вернуться после действия.
 *
 * Одно и то же действие вызывается с разных экранов: подборку собирают и со
 * списка подборок, и с карточки клиента. Жёсткий путь в действии выбрасывал
 * агента с карточки в список — ровно та беготня, ради избавления от которой
 * работу и перенесли на карточку.
 *
 * Адрес берётся из формы, поэтому проверяется: только внутренний путь
 * кабинета, без схемы и без второго слэша в начале. Открытый перенаправитель
 * получается ровно из такой мелочи.
 */
function backTo(form: FormData, fallback: string): string {
  const raw = String(form.get("return_to") ?? "");
  if (/^\/cabinet(\/[^/]|$|\?)/.test(raw)) return raw;
  return fallback;
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
  const address = String(form.get("address") ?? "").trim();
  const where = channel() === "email" ? "адрес почты" : "номер телефона";
  if (!address) return { ok: false, error: `Введите ${where}.` };

  try {
    const issued = await asAuthService(async (db) => {
      const { rows } = await db.query<{ code: string; address: string }>(
        "select code, address from app.issue_login_code($1, $2::login_channel)",
        [address, channel()],
      );
      return rows[0];
    });

    await sendLoginCode(issued.address, issued.code);

    return {
      ok: true,
      message: showsCodeOnScreen()
        ? `Код для ${issued.address}: ${issued.code} — почта не подключена, это режим разработки`
        : `Код отправлен на ${issued.address}`,
    };
  } catch (error) {
    return { ok: false, error: humanize(error) };
  }
}

export async function submitCode(_prev: unknown, form: FormData): Promise<Result> {
  const address = String(form.get("address") ?? "").trim();
  const code = String(form.get("code") ?? "").trim();
  const fullName = String(form.get("full_name") ?? "").trim();
  const phone = String(form.get("phone") ?? "").trim();

  try {
    const verified = await asAuthService(async (db) => {
      const { rows } = await db.query<{
        ok: boolean;
        reason: string | null;
        auth_user_id: string | null;
        address: string;
      }>(
        "select ok, reason, auth_user_id, address from app.verify_login_code($1, $2, $3::login_channel)",
        [address, code, channel()],
      );
      return rows[0];
    });

    // Неудачный вход база возвращает ответом, а не исключением: исключение
    // откатило бы счётчик попыток (инвариант 18).
    if (!verified?.ok || !verified.auth_user_id) {
      return { ok: false, error: verified?.reason ?? "Код не принят." };
    }

    // Вход создаёт агента или обновляет существующего. Новому ставится
    // «ожидает одобрения» — это инвариант 17, а не решение этой страницы.
    //
    // Телефон принимается только при создании: он записан со слов человека и
    // остаётся НЕПОДТВЕРЖДЁННЫМ, пока не подключён WhatsApp (инвариант 6).
    const uid = verified.auth_user_id;
    await asAuthService(async (db) => {
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: uid, email: verified.address, role: "authenticated" }),
      ]);
      await db.query("select app.login_by_email($1, $2)", [fullName || null, phone || null]);
    });

    await writeSession(uid, verified.address);
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
    // Агенту разрешены ровно три столбца: имя, Telegram и телефон
    // (инварианты 17 и 6). Почта — ключ личности, её меняет администратор.
    await db.query("update agents set full_name = $1 where auth_user_id = auth.uid()", [name]);
    return "Имя изменено.";
  }, "/cabinet/profile");
}

/**
 * Телефон агента.
 *
 * С инварианта 6 (третья редакция) он записан со слов человека и ключом
 * личности не является. Подтвердить его нечем, пока не подключён WhatsApp,
 * поэтому база отмечает его неподтверждённым — и смена номера подтверждение
 * сбрасывает. Ни одно правило системы на этот номер не опирается.
 */
export async function updateMyPhone(_prev: unknown, form: FormData): Promise<Result> {
  const phone = String(form.get("phone") ?? "").trim();
  return act(async (db) => {
    await db.query("update agents set phone = $1 where auth_user_id = auth.uid()", [
      phone || null,
    ]);
    return phone ? "Телефон сохранён." : "Телефон убран.";
  }, "/cabinet/profile");
}

/**
 * Telegram агента.
 *
 * Поле, которое экран обещал и не давал. Оно не украшение: очередь
 * уведомлений (инвариант 27) отдаёт сообщения по `agents.telegram_id`, и
 * агент без него просто не получает ничего в Telegram — молча, потому что
 * очередь ничего не нарушает, ей некуда слать.
 *
 * Номер уникален в базе: один аккаунт Telegram — один агент. Чужой номер
 * отклоняется не формой, а уникальным индексом, и ответ об этом надо
 * перевести на человеческий — «permission denied» и «duplicate key» клиенту
 * ничего не говорят.
 */
export async function updateMyTelegram(_prev: unknown, form: FormData): Promise<Result> {
  const raw = String(form.get("telegram_id") ?? "").trim();
  if (raw === "") {
    return act(async (db) => {
      await db.query(
        "update agents set telegram_id = null where auth_user_id = auth.uid()",
      );
      return "Telegram отвязан: уведомления туда приходить перестанут.";
    }, "/cabinet/profile");
  }

  // Только «это число и оно влезает в bigint». Нижней границы длины у
  // Telegram ID нет, и придуманная тут же отвергла бы значения, которые в
  // базе уже лежат. Правило, выдуманное формой, — это не правило.
  if (!/^\d{1,19}$/.test(raw) || BigInt(raw) > 9223372036854775807n) {
    return {
      ok: false,
      error:
        "Telegram ID — это число, которое присылает бот. Имя пользователя (@name) не подойдёт.",
    };
  }

  return act(async (db) => {
    try {
      await db.query(
        "update agents set telegram_id = $1 where auth_user_id = auth.uid()",
        [raw],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        throw new Error("Этот Telegram уже привязан к другому агенту.");
      }
      throw e;
    }
    return "Telegram привязан: уведомления будут приходить туда.";
  }, "/cabinet/profile");
}

/** Администратор платформы сверил номер с ТПП. */
export async function confirmCertificate(_prev: unknown, form: FormData): Promise<Result> {
  const agentId = String(form.get("agent_id"));
  return act(async (db) => {
    await db.query("select confirm_certificate($1)", [agentId]);
    return "Аттестация подтверждена.";
  }, "/cabinet/agents");
}

/** Снять подтверждение. Причина обязательна: её прочитает агент. */
export async function revokeCertificate(_prev: unknown, form: FormData): Promise<Result> {
  const agentId = String(form.get("agent_id"));
  const reason = String(form.get("reason") ?? "").trim();
  if (!reason) return { ok: false, error: "Укажите причину: её прочитает агент." };
  return act(async (db) => {
    await db.query("select revoke_certificate($1, $2)", [agentId, reason]);
    return "Подтверждение снято.";
  }, "/cabinet/agents");
}

/**
 * Аватар агента.
 *
 * Файл проходит ту же трубу, что фотография объекта: он перекодируется, и в
 * хранилище попадают наши байты, а не присланные. Порядок тот же — сначала
 * файл, потом запись в базу, и если база откажет, файл убирается.
 *
 * Старый файл удаляется ПОСЛЕ того, как новый ключ записан: наоборот значило
 * бы, что отказ базы оставляет агента без лица.
 */
export async function updateMyAvatar(_prev: unknown, form: FormData): Promise<Result> {
  const file = form.get("avatar");
  const session = await readSession();
  if (!session) return { ok: false, error: "Вход истёк. Войдите снова." };

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Файл не выбран." };
  }

  const agentId = await asAgent(session, "read only", async (db) => {
    const { rows } = await db.query<{ id: string }>("select id from me_v");
    return rows[0]?.id ?? null;
  });
  if (!agentId) return { ok: false, error: "Профиль не найден." };

  let stored;
  try {
    stored = await saveAvatarFile(agentId, file);
  } catch (error) {
    return { ok: false, error: humanize(error) };
  }

  return act(async (db) => {
    const { rows } = await db.query<{ avatar_key: string | null }>(
      "select avatar_key from agents where auth_user_id = auth.uid()",
    );
    const previous = rows[0]?.avatar_key ?? null;

    try {
      await db.query(
        "update agents set avatar_key = $1 where auth_user_id = auth.uid()",
        [stored.storageKey],
      );
    } catch (error) {
      await removePhotoFile(stored.storageKey);
      throw error;
    }

    if (previous && previous !== stored.storageKey) await removePhotoFile(previous);
    return "Фотография обновлена.";
  }, "/cabinet/profile");
}

/** Убрать аватар. Запись и файл уходят вместе, запись первой. */
export async function removeMyAvatar(): Promise<Result> {
  return act(async (db) => {
    const { rows } = await db.query<{ avatar_key: string | null }>(
      "select avatar_key from agents where auth_user_id = auth.uid()",
    );
    const previous = rows[0]?.avatar_key ?? null;
    if (!previous) return "Фотографии и так не было.";

    await db.query("update agents set avatar_key = null where auth_user_id = auth.uid()");
    await removePhotoFile(previous);
    return "Фотография убрана.";
  }, "/cabinet/profile");
}

/**
 * Аттестация ТПП со слов агента.
 *
 * Сохраняется как ЗАЯВЛЕНИЕ: подтверждение ставит администратор платформы,
 * сверив номер с палатой вручную — онлайн-реестра, который можно спросить
 * запросом, у неё пока нет. Правка номера или дат сбрасывает подтверждение,
 * и это делает база, а не эта функция.
 *
 * Срок по умолчанию — пять лет от выдачи: столько действует сертификат.
 */
export async function updateMyCertificate(_prev: unknown, form: FormData): Promise<Result> {
  const text = (name: string) => {
    const v = String(form.get(name) ?? "").trim();
    return v === "" ? null : v;
  };
  const no = text("certificate_no");
  const issued = text("certificate_issued_on");
  let validTo = text("certificate_valid_to");

  if (no === null) {
    return act(async (db) => {
      await db.query(
        `update agents set certificate_no = null, certificate_issued_on = null,
                           certificate_valid_to = null
          where auth_user_id = auth.uid()`,
      );
      return "Номер убран: аттестация больше не заявлена.";
    }, "/cabinet/profile");
  }

  if (no.length < 3) {
    return { ok: false, error: "Номер слишком короткий — проверьте сертификат." };
  }
  if (issued && !validTo) {
    const d = new Date(`${issued}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      d.setUTCFullYear(d.getUTCFullYear() + 5);
      validTo = d.toISOString().slice(0, 10);
    }
  }

  return act(async (db) => {
    try {
      await db.query(
        `update agents set certificate_no = $1,
                           certificate_issued_on = $2::date,
                           certificate_valid_to = $3::date
          where auth_user_id = auth.uid()`,
        [no, issued, validTo],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        throw new Error("Этот номер уже заявлен другим агентом.");
      }
      throw e;
    }
    return "Номер сохранён. Он помечен заявленным, пока администратор не сверит его с палатой.";
  }, "/cabinet/profile");
}

// ---------------------------------------------------------------------------
// Подбор
// ---------------------------------------------------------------------------

/**
 * Потребность клиента. Как и объект, заводится вместе с человеком: клиент и
 * то, что он ищет, — один разговор.
 */
export async function createRequirement(_prev: unknown, form: FormData): Promise<Result> {
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
  // Районы и комнаты приходят списком через запятую: это короче любого
  // набора галочек и переживает появление нового района.
  const list = (name: string) =>
    (text(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const session = await readSession();
  if (!session) return { ok: false, error: "Вход истёк. Войдите снова." };

  let id: string;
  try {
    id = await asAgent(session, "read write", async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `select id from create_requirement(
           $1::deal_type,
           p_contact_id   => $2::uuid,
           p_client_name  => $3,
           p_client_phone => $4,
           p_budget_min   => $5::numeric,
           p_budget_max   => $6::numeric,
           p_zones        => $7::text[],
           p_rooms        => $8::smallint[],
           p_deadline     => $9::date,
           p_text         => $10,
           p_inquiry_id   => $11::uuid)`,
        [
          text("deal_type"), text("contact_id"), text("client_name"), text("client_phone"),
          num("budget_min"), num("budget_max"),
          list("zones"),
          list("rooms").map((r) => Number(r)).filter((n) => Number.isFinite(n)),
          text("deadline"), text("requirements_text"), text("inquiry_id"),
        ],
      );
      return rows[0].id;
    });
  } catch (error) {
    return { ok: false, error: humanize(error) };
  }

  revalidatePath("/cabinet/requirements");
  redirect(`/cabinet/requirements/${id}?note=${encodeURIComponent("Потребность заведена. Ниже — что ей подходит.")}`);
}

export async function proposeObject(_prev: unknown, form: FormData): Promise<Result> {
  const requirementId = String(form.get("requirement_id"));
  const objectId = String(form.get("object_id"));
  return actThenNotice(async (db) => {
    const { rows } = await db.query<{ address: string }>(
      `select o.address from create_match($1, $2) m join objects o on o.id = m.object_id`,
      [objectId, requirementId],
    );
    return `«${rows[0].address}» предложен клиенту.`;
  }, `/cabinet/requirements/${requirementId}`);
}

/**
 * Куда вернуться после действия над показом.
 *
 * Показ живёт на двух экранах: в карточке клиента (там его назначают) и на
 * экране показов (там его закрывают). Уведомление об успехе должно появиться
 * на той странице, с которой нажали, поэтому адрес приходит из формы, а не
 * зашит здесь. Значение проверяется: оно попадает в redirect, и принимать
 * туда чужую строку нельзя.
 */
function showingBack(form: FormData): string {
  const requirementId = String(form.get("requirement_id") ?? "");
  if (/^[0-9a-f-]{36}$/.test(requirementId)) {
    return `/cabinet/requirements/${requirementId}`;
  }
  return "/cabinet/showings";
}

export async function scheduleShowing(_prev: unknown, form: FormData): Promise<Result> {
  const matchId = String(form.get("match_id"));
  const at = String(form.get("at") ?? "").trim();
  const note = String(form.get("note") ?? "").trim();
  if (!at) return { ok: false, error: "Укажите дату и время показа." };

  return actThenNotice(async (db) => {
    await db.query("select schedule_showing($1, $2::timestamptz, $3)", [matchId, at, note || null]);
    return "Показ назначен.";
  }, showingBack(form));
}

export async function completeShowing(_prev: unknown, form: FormData): Promise<Result> {
  const showingId = String(form.get("showing_id"));
  const outcome = String(form.get("outcome"));
  const reaction = String(form.get("reaction") ?? "").trim();
  const note = String(form.get("note") ?? "").trim();

  return actThenNotice(async (db) => {
    await db.query(
      "select complete_showing($1, $2::showing_outcome, $3, $4)",
      [showingId, outcome, reaction || null, note || null],
    );
    return "Показ закрыт. Состояние подбора и потребности обновлено автоматически.";
  }, showingBack(form));
}

export async function cancelShowing(_prev: unknown, form: FormData): Promise<Result> {
  const showingId = String(form.get("showing_id"));
  const reason = String(form.get("reason") ?? "").trim();
  return actThenNotice(async (db) => {
    await db.query("select cancel_showing($1, $2)", [showingId, reason || null]);
    return "Показ отменён.";
  }, showingBack(form));
}

/**
 * Клиент не пришёл.
 *
 * Отдельное действие, а не «отмена с причиной»: отменяют договорившись, а
 * здесь агент приехал и стоял у подъезда. Собственнику в отчёте это говорит
 * разное (инвариант 25).
 */
export async function markNoShow(_prev: unknown, form: FormData): Promise<Result> {
  const showingId = String(form.get("showing_id"));
  const note = String(form.get("note") ?? "").trim();
  return actThenNotice(async (db) => {
    await db.query("select mark_no_show($1, $2)", [showingId, note || null]);
    return "Отмечено: клиент не пришёл.";
  }, showingBack(form));
}

export async function rescheduleShowing(_prev: unknown, form: FormData): Promise<Result> {
  const showingId = String(form.get("showing_id"));
  const at = String(form.get("at") ?? "").trim();
  if (!at) return { ok: false, error: "Укажите новое время показа." };
  return actThenNotice(async (db) => {
    await db.query("select reschedule_showing($1, $2::timestamptz)", [showingId, at]);
    return "Показ перенесён.";
  }, showingBack(form));
}

// ---------------------------------------------------------------------------
// Сделки
// ---------------------------------------------------------------------------

export async function startDeal(_prev: unknown, form: FormData): Promise<Result> {
  const matchId = String(form.get("match_id"));
  const requirementId = String(form.get("requirement_id"));

  const session = await readSession();
  if (!session) return { ok: false, error: "Вход истёк. Войдите снова." };

  let dealId: string;
  try {
    dealId = await asAgent(session, "read write", async (db) => {
      const { rows } = await db.query<{ id: string }>(
        "select id from create_deal_from_match($1)",
        [matchId],
      );
      return rows[0].id;
    });
  } catch (error) {
    return { ok: false, error: humanize(error) };
  }

  revalidatePath(`/cabinet/requirements/${requirementId}`);
  redirect(`/cabinet/deals/${dealId}?note=${encodeURIComponent("Сделка заведена. Пока она не закрыта, суммы индикативны.")}`);
}

export async function closeDeal(_prev: unknown, form: FormData): Promise<Result> {
  const dealId = String(form.get("deal_id"));
  const price = String(form.get("final_price") ?? "").replace(/\s/g, "").replace(",", ".");

  return actThenNotice(async (db) => {
    const { rows } = await db.query<{ commission_total: string; my: string | null }>(
      `select commission_total::text,
              case when listing_agent_id = app.current_agent_id() then listing_share::text
                   when closing_agent_id = app.current_agent_id() then closing_share::text
              end as my
         from close_deal($1, $2::numeric)`,
      [dealId, price],
    );
    const total = Number(rows[0].commission_total).toLocaleString("ru-RU");
    const mine = rows[0].my ? Number(rows[0].my).toLocaleString("ru-RU") : null;
    return `Сделка закрыта. Комиссия ${total}${mine ? `, ваша доля ${mine}` : ""}. Суммы зафиксированы.`;
  }, `/cabinet/deals/${dealId}`);
}

export async function failDeal(_prev: unknown, form: FormData): Promise<Result> {
  const dealId = String(form.get("deal_id"));
  const reason = String(form.get("reason") ?? "").trim();
  if (!reason) return { ok: false, error: "Причина срыва обязательна." };

  return actThenNotice(async (db) => {
    await db.query("select fail_deal($1, $2)", [dealId, reason]);
    return "Сделка сорвана. Клиент и подбор вернулись в работу.";
  }, `/cabinet/deals/${dealId}`);
}

// ---------------------------------------------------------------------------
// Правка
// ---------------------------------------------------------------------------
// Все четыре действия — вызов функции базы, и ни одно не проверяет прав:
// это решают триггер инварианта 22 и сами функции. Экран показывает форму
// тому, кому она пригодится, но запрещает не он.

export async function updateObject(_prev: unknown, form: FormData): Promise<Result> {
  const objectId = String(form.get("object_id"));
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

  return actThenNotice(async (db) => {
    await db.query(
      `select update_object($1, $2::numeric, $3,
         p_zone => $4, p_rooms => $5::smallint, p_area => $6::numeric,
         p_floor => $7::smallint, p_floors_total => $8::smallint,
         p_currency => $9, p_description => $10)`,
      [objectId, num("price"), text("address"), text("zone"), num("rooms"),
       num("area"), num("floor"), num("floors_total"), text("currency"),
       text("description")],
    );
    return "Объект изменён.";
  }, `/cabinet/objects/${objectId}`);
}

export async function updateMandate(_prev: unknown, form: FormData): Promise<Result> {
  const objectId = String(form.get("object_id"));
  const mandateId = String(form.get("mandate_id"));
  const kind = String(form.get("mandate_kind"));
  const validTo = String(form.get("valid_to") ?? "").trim() || null;
  const confirmed = form.get("contract_confirmed") === "on";

  return actThenNotice(async (db) => {
    await db.query(
      `select update_mandate($1, $2::mandate_kind, $3::date, $4::boolean)`,
      [mandateId, kind, validTo, confirmed],
    );
    return "Договор изменён.";
  }, `/cabinet/objects/${objectId}`);
}

export async function updateClosingShare(_prev: unknown, form: FormData): Promise<Result> {
  const objectId = String(form.get("object_id"));
  const mandateId = String(form.get("mandate_id"));
  const percent = Number(String(form.get("percent") ?? "").replace(",", "."));
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    return { ok: false, error: "Ставка должна быть от 1 до 99 процентов." };
  }

  return actThenNotice(async (db) => {
    // В базе ставка — доля единицы: так её удобно складывать и проверять.
    // Человеку привычнее проценты, и перевод делает экран, а не база.
    await db.query("select set_closing_share($1, $2::numeric)", [mandateId, percent / 100]);
    return `Ставка агента покупателя: ${percent}%.`;
  }, `/cabinet/objects/${objectId}`);
}

export async function updateRequirement(_prev: unknown, form: FormData): Promise<Result> {
  const requirementId = String(form.get("requirement_id"));
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
  const list = (name: string) =>
    (text(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  return actThenNotice(async (db) => {
    await db.query(
      `select update_requirement($1, $2::numeric, $3::numeric, $4::text[],
                                 $5::smallint[], $6::date, $7)`,
      [requirementId, num("budget_min"), num("budget_max"), list("zones"),
       list("rooms").map(Number).filter((n) => Number.isFinite(n)),
       text("deadline"), text("requirements_text")],
    );
    return "Условия изменены. Подбор ниже пересчитан.";
  }, `/cabinet/requirements/${requirementId}`);
}

export async function updateContact(_prev: unknown, form: FormData): Promise<Result> {
  const contactId = String(form.get("contact_id"));
  const back = String(form.get("back") ?? "/cabinet");
  const name = String(form.get("name") ?? "").trim();
  const phone = String(form.get("phone") ?? "").trim();
  if (!name) return { ok: false, error: "Имя обязательно." };

  return actThenNotice(async (db) => {
    await db.query("select update_contact($1, $2, $3)", [contactId, name, phone || null]);
    return "Контакт изменён.";
  }, back);
}

// ---------------------------------------------------------------------------
// Передача
// ---------------------------------------------------------------------------
// Главный случай — отпуск или увольнение. Правило «ведёт тот, кто ведёт»
// (инварианты 20 и 22) без передачи означает, что работа встаёт.

export async function transferObject(_prev: unknown, form: FormData): Promise<Result> {
  const objectId = String(form.get("object_id"));
  const toAgent = String(form.get("to_agent") ?? "");
  if (!toAgent) return { ok: false, error: "Выберите, кому передать." };

  return actThenNotice(async (db) => {
    const { rows } = await db.query<{ full_name: string }>(
      `select a.full_name from transfer_object($1, $2) m
         join agents a on a.id = m.listing_agent_id`,
      [objectId, toAgent],
    );
    return `Объект передан: ${rows[0].full_name}. Незакрытые сделки перешли вместе с ним.`;
  }, `/cabinet/objects/${objectId}`);
}

export async function transferRequirement(_prev: unknown, form: FormData): Promise<Result> {
  const requirementId = String(form.get("requirement_id"));
  const toAgent = String(form.get("to_agent") ?? "");
  if (!toAgent) return { ok: false, error: "Выберите, кому передать." };

  return actThenNotice(async (db) => {
    const { rows } = await db.query<{ full_name: string }>(
      `select a.full_name from transfer_requirement($1, $2) r
         join agents a on a.id = r.agent_id`,
      [requirementId, toAgent],
    );
    return `Клиент передан: ${rows[0].full_name}. Подборы в работе перешли вместе с ним.`;
  }, `/cabinet/requirements/${requirementId}`);
}

export async function setDealStage(_prev: unknown, form: FormData): Promise<Result> {
  const dealId = String(form.get("deal_id"));
  const stage = String(form.get("stage"));

  return actThenNotice(async (db) => {
    await db.query("select set_deal_stage($1, $2::deal_status)", [dealId, stage]);
    return "Этап изменён.";
  }, `/cabinet/deals/${dealId}`);
}

// ---------------------------------------------------------------------------
// Выгрузка на площадки
// ---------------------------------------------------------------------------

/**
 * Включить или выключить площадку для объекта.
 *
 * Проверок прав здесь нет: площадками объекта распоряжается агент его
 * договора, и это решает триггер инварианта 28. Прямая запись в таблицу
 * закрыта правами — путь ровно один, через set_channel().
 */
export async function setChannel(_prev: unknown, form: FormData): Promise<Result> {
  const objectId = String(form.get("object_id"));
  const channel = String(form.get("channel"));
  const enabled = String(form.get("enabled")) === "1";

  return actThenNotice(async (db) => {
    await db.query("select set_channel($1, $2::publication_channel, $3)", [
      objectId,
      channel,
      enabled,
    ]);
    return enabled ? "Площадка включена." : "Площадка выключена.";
  }, `/cabinet/objects/${objectId}`);
}

/** Новая ссылка на фид. Старая перестаёт работать сразу. */
export async function rotateFeedToken(_prev: unknown, form: FormData): Promise<Result> {
  const channel = String(form.get("channel"));
  return actThenNotice(async (db) => {
    await db.query("select app.rotate_feed_token($1::publication_channel)", [channel]);
    return "Ссылка заменена. Старая больше не работает — выдайте площадке новую.";
  }, "/cabinet/channels");
}

/**
 * Схема фида канала и контакт для неё.
 *
 * Подтверждение схемы ставится руками и означает ровно одно: её видел
 * человек — в спецификации площадки или в её ответе на пробный фид. Пока
 * галочки нет, кабинет честно пишет, что схема выбрана предположительно.
 */
export async function setFeedFormat(_prev: unknown, form: FormData): Promise<Result> {
  const channel = String(form.get("channel"));
  const format = String(form.get("format"));
  const confirmed = String(form.get("confirmed")) === "1";
  const contact = String(form.get("contact") ?? "").trim();

  return actThenNotice(async (db) => {
    await db.query(
      "select set_feed_format($1::publication_channel, $2::feed_format, $3, $4)",
      [channel, format, confirmed, contact || null],
    );
    return "Настройки канала сохранены.";
  }, "/cabinet/channels");
}

// ---------------------------------------------------------------------------
// Воронка (инвариант 30)
// ---------------------------------------------------------------------------
// Два перехода, и только они: остальные колонки ставит работа, а не кнопка.
// Экран не повторяет матрицу переходов из базы — он показывает кнопку там,
// где база разрешит, и отдаёт её отказ словами, если не разрешит.

export async function qualifyRequirement(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("requirement_id"));
  return actThenNotice(async (db) => {
    await db.query("select qualify_requirement($1)", [id]);
    return "Клиент взят в работу.";
  }, "/cabinet/funnel");
}

export async function loseRequirement(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("requirement_id"));
  const reason = String(form.get("reason") ?? "").trim();
  return actThenNotice(async (db) => {
    await db.query("select lose_requirement($1, $2)", [id, reason || null]);
    return "Клиент закрыт с причиной.";
  }, "/cabinet/funnel");
}

// ---------------------------------------------------------------------------
// Задачи и напоминания (инвариант 31)
// ---------------------------------------------------------------------------

/**
 * Срок приходит с экрана как местное время Бишкека: `datetime-local` отдаёт
 * строку без пояса, и отправить её как есть значит записать 15:00 UTC.
 * Та же ошибка, что была на экране показов, и чинится она в одном месте.
 */
function bishkekStamp(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  return `${raw.replace("T", " ")} Asia/Bishkek`;
}

export async function createTask(_prev: unknown, form: FormData): Promise<Result> {
  const title = String(form.get("title") ?? "").trim();
  const due = bishkekStamp(String(form.get("due_at") ?? ""));
  const kind = String(form.get("kind") ?? "call");
  const agent = String(form.get("agent_id") ?? "").trim();
  const requirement = String(form.get("requirement_id") ?? "").trim();
  const path = String(form.get("path") ?? "/cabinet/tasks");

  if (!due) return { ok: false, error: "Без срока это не напоминание. Поставьте дату и время." };

  return actThenNotice(async (db) => {
    await db.query(
      `select create_task($1, $2::timestamptz, $3::task_kind, $4, null, $5)`,
      [title, due, kind, agent || null, requirement || null],
    );
    return "Напоминание поставлено.";
  }, path);
}

export async function completeTask(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("task_id"));
  const note = String(form.get("note") ?? "").trim();
  const path = String(form.get("path") ?? "/cabinet/tasks");
  return actThenNotice(async (db) => {
    await db.query("select complete_task($1, $2)", [id, note || null]);
    return "Сделано.";
  }, path);
}

export async function cancelTask(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("task_id"));
  const reason = String(form.get("reason") ?? "").trim();
  const path = String(form.get("path") ?? "/cabinet/tasks");
  return actThenNotice(async (db) => {
    await db.query("select cancel_task($1, $2)", [id, reason || null]);
    return "Задача снята.";
  }, path);
}

export async function rescheduleTask(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("task_id"));
  const due = bishkekStamp(String(form.get("due_at") ?? ""));
  const path = String(form.get("path") ?? "/cabinet/tasks");
  if (!due) return { ok: false, error: "Новый срок не указан." };
  return actThenNotice(async (db) => {
    await db.query("select reschedule_task($1, $2::timestamptz)", [id, due]);
    return "Срок перенесён. Напоминание выпустится заново.";
  }, path);
}

// ---------------------------------------------------------------------------
// Воронка объектов (инвариант 32)
// ---------------------------------------------------------------------------

export async function setOwnerStage(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("object_id"));
  const stage = String(form.get("stage"));
  const path = String(form.get("path") ?? "/cabinet/listings");
  return actThenNotice(async (db) => {
    await db.query("select set_owner_stage($1, $2::owner_stage)", [id, stage]);
    return stage === "called" ? "Отмечено: дозвонились." : "Отмечено: съездили на осмотр.";
  }, path);
}

export async function signMandate(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("object_id"));
  const kind = String(form.get("mandate_kind") ?? "non_exclusive");
  const validTo = String(form.get("valid_to") ?? "").trim();
  const confirmed = form.get("contract_confirmed") === "on";
  const path = String(form.get("path") ?? "/cabinet/listings");
  return actThenNotice(async (db) => {
    await db.query(
      "select sign_mandate($1, $2::mandate_kind, $3::date, null, $4)",
      [id, kind, validTo || null, confirmed],
    );
    return confirmed
      ? "Договор заключён и отмечен подписанным."
      : "Договор заключён. Пока он не подписан, объект виден коллегам как риск.";
  }, path);
}

export async function confirmMandate(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("object_id"));
  const path = String(form.get("path") ?? "/cabinet/listings");
  return actThenNotice(async (db) => {
    await db.query("select confirm_mandate($1)", [id]);
    return "Договор подписан. Объект взят в работу.";
  }, path);
}

// ---------------------------------------------------------------------------
// Подборки (инвариант 36)
// ---------------------------------------------------------------------------

export async function createSelection(_prev: unknown, form: FormData): Promise<Result> {
  const requirement = String(form.get("requirement_id"));
  const note = String(form.get("note") ?? "").trim();
  const ids = form.getAll("object_id").map(String).filter(Boolean);
  if (ids.length === 0) {
    return { ok: false, error: "Отметьте хотя бы один объект: пустая подборка ничего не говорит клиенту." };
  }
  return actThenNotice(async (db) => {
    await db.query("select create_selection($1, $2::uuid[], $3)",
                   [requirement, ids, note || null]);
    return "Подборка собрана. Пока она черновик — состав ещё можно менять.";
  }, backTo(form, "/cabinet/selections"));
}

export async function sendSelection(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("selection_id"));
  return actThenNotice(async (db) => {
    await db.query("select send_selection($1)", [id]);
    return "Отправлено. С этого момента состав подборки неизменен.";
  }, backTo(form, "/cabinet/selections"));
}

export async function revokeSelection(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("selection_id"));
  return actThenNotice(async (db) => {
    await db.query("select revoke_selection($1)", [id]);
    return "Ссылка отозвана: клиент больше её не откроет.";
  }, backTo(form, "/cabinet/selections"));
}

export async function setSelectionReaction(_prev: unknown, form: FormData): Promise<Result> {
  const id = String(form.get("selection_id"));
  const object = String(form.get("object_id"));
  const reaction = String(form.get("reaction"));
  const note = String(form.get("note") ?? "").trim();
  return actThenNotice(async (db) => {
    await db.query("select set_selection_reaction($1, $2, $3, $4)",
                   [id, object, reaction, note || null]);
    return "Записано.";
  }, "/cabinet/selections");
}
