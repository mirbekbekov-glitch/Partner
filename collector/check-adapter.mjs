// Проверка адаптера на образце страницы. Сети нет: разбор проверяется на
// сохранённом HTML, поэтому тест не зависит ни от доступности сайта, ни от
// того, какие объявления на нём сегодня.
//
//   node collector/check-adapter.mjs [файл.html] [адрес]

import { readFileSync } from "node:fs";
import { parseItemPage, parseListPage, phoneFromText, isAllowedPath, externalIdFromUrl }
  from "./adapters/house-kg.mjs";

let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ok  " : "ПРОВАЛ"} ${label}`);
  if (!cond) failed += 1;
};
const eq = (actual, expected, label) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${same ? "  ok  " : "ПРОВАЛ"} ${label}${same ? ` (= ${JSON.stringify(actual)})` : `\n        ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`}`);
  if (!same) failed += 1;
};

const file = process.argv[2] ?? new URL("fixtures/house-kg-item.html", import.meta.url);
const url = process.argv[3] ?? "https://www.house.kg/details/00000000aaaa0000bbbb0-12345678";
const html = readFileSync(file, "utf8");

console.log("── разбор страницы объявления");
const item = parseItemPage(html, url);
ok(item !== null, "страница распознана как объявление");
eq(item.external_id, externalIdFromUrl(url), "идентификатор взят из адреса");
eq(item.kind, "flat", "вид объекта");
eq(item.deal_type, "sale", "тип сделки из заголовка");
eq(item.rooms, 3, "комнат");
eq(item.area, 80, "площадь");
eq(item.floor, 9, "этаж");
eq(item.floors_total, 10, "этажей в доме — только из названия");
eq(item.price, 17432400, "цена");
eq(item.currency, "KGS", "валюта как на площадке, а не наша");
eq(item.photos_count, 8, "число фотографий");
eq(item.author, "owner", "автор объявления");
ok(item.address && item.address.includes("Бишкек"), `адрес: ${item.address}`);
eq(item.zone, "7 м-н", "район из адреса");
ok(item.raw.listing && item.raw.date_posted, "исходный блок сохранён для починки разбора");

console.log("\n── телефон");
eq(phoneFromText("Ответственный: Темирлан Номер ответственного:996 558 619 615"),
   "996 558 619 615", "номер из текста объявления достаётся");
eq(phoneFromText("Квартира с ремонтом, 80 кв м, 3 комнаты"), null,
   "случайные числа номером не считаются");

console.log("\n── границы, которые адаптер не переходит");
ok(!isAllowedPath("/api/listings/123"), "/api/ запрещён в robots.txt сайта");
ok(!isAllowedPath("/ru/profile"), "личный кабинет не трогаем");
ok(isAllowedPath("/details/abc-123"), "страница объявления разрешена");
ok(isAllowedPath("/kupit-kvartiru?town=2"), "страница поиска разрешена");

console.log("\n── страница списка");
const listFile = process.argv[4] ?? new URL("fixtures/house-kg-list.html", import.meta.url);
const links = parseListPage(readFileSync(listFile, "utf8"));
ok(links.length > 0, `ссылок на объявления: ${links.length}`);
ok(links.every((l) => externalIdFromUrl(l)), "все ссылки ведут на объявления");

console.log(failed === 0 ? "\nразбор проверен" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
