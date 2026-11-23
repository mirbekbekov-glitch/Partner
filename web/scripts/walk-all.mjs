// Все обходы браузером подряд.
//
//   npm run walk            — по стенду из WALK_BASE (по умолчанию :3000)
//   WALK_BASE=http://127.0.0.1:3001 npm run walk
//
// Обходы НЕ зависят друг от друга и от порядка: каждый готовит себе то, на
// чём держится, и ни один не рассчитывает на следы предыдущего. Это было не
// так, и стоило дорого — половина набора падала, причём падения выглядели как
// поломки продукта: «подбор пуст», «нет клиентов в работе», «ни одного
// объекта, требующего внимания». Если обход снова начнёт зависеть от соседа,
// это видно отсюда: прогон двух кругов подряд обязан дать одно и то же.
//
// Между обходами чистятся коды входа: вход ограничен пятью кодами в час на
// адрес (инвариант 6), и на пятом обходе набор упирался бы в собственный
// ограничитель. Ограничитель прав, чистка — подготовка данных разработки.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const rounds = Number(process.env.WALK_ROUNDS ?? 1);
const only = process.argv.slice(2);

const walks = readdirSync(here)
  .filter((f) => f.startsWith("walk-") && f.endsWith(".mjs") && f !== "walk-all.mjs")
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort();

const dbUrl = readFileSync(join(here, "..", ".env"), "utf8").match(/^DATABASE_URL=(.*)$/m)?.[1];

let failed = 0;
for (let round = 1; round <= rounds; round += 1) {
  if (rounds > 1) console.log(`\n=== круг ${round}`);
  for (const walk of walks) {
    if (dbUrl) {
      const db = new pg.Client({ connectionString: dbUrl });
      await db.connect();
      await db.query("delete from login_codes");
      await db.end();
    }
    process.stdout.write(`  ${walk.replace(/^walk-|\.mjs$/g, "").padEnd(16)} `);
    try {
      const out = execFileSync(process.execPath, [join(here, walk)], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env,
      });
      if (!/проход завершён/.test(out)) throw new Error(out.slice(-400));
      console.log("ok");
    } catch (error) {
      failed += 1;
      console.log("ПАДАЕТ");
      const text = String(error.stdout ?? "") + String(error.stderr ?? error.message ?? "");
      for (const line of text.split("\n").filter((l) => /^Error|error:|locator\.|page\.wait/.test(l)).slice(0, 2)) {
        console.log(`      ${line.trim()}`);
      }
    }
  }
}

console.log(failed === 0 ? "\nвсе обходы прошли" : `\nПРОВАЛЕНО обходов: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
