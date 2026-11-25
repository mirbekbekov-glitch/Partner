/**
 * Хранилище фотографий: Supabase Storage по его СОБСТВЕННОМУ интерфейсу.
 *
 * ЗАЧЕМ ЧЕТВЁРТЫЙ ДРАЙВЕР, если s3 уже умеет Supabase. Потому что по
 * S3-протоколу Supabase требует отдельные ключи доступа, а завести их можно
 * только руками в панели: в управляющем API такой возможности нет. То есть
 * драйвер s3 упирается в действие человека, которое нельзя сделать за него.
 *
 * А REST-интерфейс хранилища принимает обычный служебный ключ проекта — тот
 * самый, который управляющий API отдаёт. Значит выкладывание перестаёт ждать
 * чужих рук.
 *
 * Разница только в способе представиться. Бакет остаётся ЗАКРЫТЫМ, публичных
 * адресов у файлов нет, байты по-прежнему отдаёт приложение после проверки
 * права в базе — инвариант 11 цел.
 *
 * КЛЮЧ — СЛУЖЕБНЫЙ, и это стоит назвать прямо: он обходит политики RLS в
 * хранилище. Здесь это приемлемо ровно потому, что драйвер умеет три вещи и
 * ни одна из них не решает, КОМУ отдать файл: право проверяется до вызова, в
 * базе. Ключ живёт секретом воркера и в репозиторий не попадает.
 *
 * УДАЛЁННЫЙ ФАЙЛ ЕЩЁ КАКОЕ-ТО ВРЕМЯ ЧИТАЕТСЯ, и это не наша ошибка. Перед
 * хранилищем стоит кэш: `remove()` отвечает «удалено», список в бакете сразу
 * пуст, запрос в обход кэша отвечает «нет такого», а обычный ещё отдаёт
 * байты (`cf-cache-status: HIT`), и заголовок `cache-control: no-cache` его
 * не сдвигает. Проверено запросами.
 *
 * На инвариант 11 это не влияет: право на файл проверяется в БАЗЕ до всякого
 * обращения к хранилищу, и снятый с публикации объект перестаёт отдаваться в
 * ту же секунду независимо от того, лежат ли ещё байты в кэше. Написано здесь
 * затем, что без этой записи следующий читающий проверит удаление чтением и
 * решит, что драйвер сломан. Я чуть не решил.
 */

import type { Driver, StoredObject } from "./storage.ts";

function settings() {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const bucket = process.env.PHOTO_BUCKET;

  if (!base) {
    throw new Error(
      "SUPABASE_URL не задан, а PHOTO_STORAGE=supabase. Ожидается https://<ref>.supabase.co.",
    );
  }
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_KEY не задан, а PHOTO_STORAGE=supabase. В бою это секрет воркера, а не переменная в репозитории.",
    );
  }
  if (!bucket) {
    throw new Error("PHOTO_BUCKET не задан, а PHOTO_STORAGE=supabase.");
  }
  return { base: base.replace(/\/+$/, ""), key, bucket };
}

/**
 * Ключ объекта в адресе кодируется посегментно.
 *
 * Наши ключи вида `objects/<uuid>/<hex>.jpg` безопасны целиком, но кодировать
 * их всё равно надо правильно: `encodeURIComponent` съел бы разделители, а
 * без кодирования любой будущий ключ с пробелом ломал бы запрос молча.
 */
function pathOf(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export const driver: Driver = {
  async put(key, bytes, contentType) {
    const { base, key: token, bucket } = settings();
    const response = await fetch(
      `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${pathOf(key)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": contentType,
          // Перезапись разрешена: ключ выдаёт вызывающий, и повторная
          // попытка загрузки не должна падать на том, что байты уже легли.
          "x-upsert": "true",
        },
        body: bytes,
      },
    );
    if (!response.ok) {
      throw new Error(
        `Supabase Storage не принял файл (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`,
      );
    }
  },

  async read(key): Promise<StoredObject | null> {
    const { base, key: token, bucket } = settings();
    const response = await fetch(
      `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${pathOf(key)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    // Нет файла — это ответ, а не ошибка: запись в базе может пережить байты.
    //
    // Но «нет файла» Supabase сообщает кодом 400, а не 404, и тем же кодом —
    // «ключ никуда не годится» (InvalidKey). Считать оба за «файла нет»
    // значит прятать настоящую ошибку: кривой ключ выглядел бы пустым местом
    // на карточке, и никто бы не узнал, почему. Поэтому разбирается тело.
    if (response.status === 404) return null;
    if (response.status === 400) {
      const said = await response.text();
      if (/not_found|NoSuchKey/i.test(said)) return null;
      throw new Error(`Supabase Storage отверг запрос: ${said.slice(0, 200)}`);
    }
    if (!response.ok || !response.body) {
      throw new Error(
        `Supabase Storage не отдал файл (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`,
      );
    }

    const length = response.headers.get("content-length");
    return {
      body: response.body,
      size: length === null ? null : Number(length),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  },

  async remove(key) {
    const { base, key: token, bucket } = settings();
    const response = await fetch(
      `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${pathOf(key)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
    );
    // Отсутствие файла ошибкой не считается: запись уже удалена. Здесь 400
    // разбирать незачем: удалять нечего и при негодном ключе.
    if (!response.ok && response.status !== 404 && response.status !== 400) {
      throw new Error(
        `Supabase Storage не убрал файл (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`,
      );
    }
  },
};
