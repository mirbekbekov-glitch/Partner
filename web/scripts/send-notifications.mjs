// Разбор очереди уведомлений: взять пачку, отправить, отметить.
//
//   node scripts/send-notifications.mjs            один проход
//   node scripts/send-notifications.mjs --loop     каждую минуту
//
// Отдельный процесс, а не часть сервера: отправка это сеть, а сеть внутри
// обработчика страницы однажды подвесит страницу. Ходит под ролью notifier —
// ей открыты три функции и ни одной таблицы (инвариант 27).
import { readFileSync } from "node:fs";
import pg from "pg";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// Как в smoke-photos.mjs: типы снимаются на лету, запускать через
// `npm run notify` (node --experimental-strip-types).
const { sendNotification, transport } = await import("../lib/notify.ts");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const BATCH = Number(process.env.NOTIFY_BATCH ?? 20);

async function asNotifier(sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local time zone 'Asia/Bishkek'");
    await client.query(`set local role ${process.env.NOTIFY_DB_ROLE ?? "notifier"}`);
    const result = await client.query(sql, params);
    await client.query("commit");
    return result.rows;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function pass() {
  const batch = await asNotifier("select * from app.take_notifications($1)", [BATCH]);
  let sent = 0;
  let failed = 0;

  for (const out of batch) {
    try {
      await sendNotification(out);
      await asNotifier("select app.mark_notification_sent($1)", [out.id]);
      sent += 1;
    } catch (error) {
      // Неудача — это запись, а не исключение: уведомление вернётся в
      // очередь, а причина будет видна агенту на экране уведомлений.
      const reason = error instanceof Error ? error.message : String(error);
      await asNotifier("select app.mark_notification_failed($1, $2)", [out.id, reason]);
      failed += 1;
    }
  }

  if (batch.length > 0) {
    console.log(`канал ${transport()}: отправлено ${sent}, не ушло ${failed}`);
  }
  return batch.length;
}

try {
  if (process.argv.includes("--loop")) {
    console.log(`разбор очереди запущен, канал ${transport()}`);
    for (;;) {
      await pass();
      await new Promise((r) => setTimeout(r, 60_000));
    }
  } else {
    const n = await pass();
    if (n === 0) console.log("очередь пуста");
  }
} finally {
  await pool.end();
}
