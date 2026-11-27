/**
 * Разбор выгрузки каталога старого сайта.
 *
 * Старый сайт раз в сутки присылает свой каталог CSV-файлом на чужой
 * Worker, тот складывает его одной строкой в базу liberterra-catalog.
 * Здесь файл превращается в черновики объектов.
 *
 * Модуль нарочно чистый: ни базы, ни привязок, ни server-only. Разбор и
 * раскладка полей — то, что ломается тише всего и проверяется тестами;
 * запись в базу живёт отдельно, в lib/db/catalog-import.ts.
 *
 * ГЛАВНОЕ ПРО ЭТУ ВЫГРУЗКУ. В ней лежат не только объявления. Из 283
 * строк на 27 ноября 2026 года 281 — это «Запрос»: человек ИЩЕТ жильё, у
 * строки есть район, бюджет и ссылка на Telegram, но нет ни площади, ни
 * фотографий, ни агента. Объект из такого запроса завести нельзя — это
 * чужая потребность, а не чья-то квартира. Поэтому выборка здесь строгая
 * и всё непонятное пропускается с причиной, а не угадывается.
 */

export type CatalogRow = Record<string, string>;

/**
 * CSV в строки.
 *
 * Своё, а не библиотека: в описаниях объявлений встречаются и переводы
 * строк, и кавычки, и запятые, то есть ровно те случаи, ради которых
 * кавычки в CSV и придуманы. Разбор посимвольный — он короче, чем попытка
 * обойтись регулярным выражением, и не врёт на многострочном поле.
 */
export function parseCsv(text: string): CatalogRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  // Разделители строк у разных источников разные; сводим к одному.
  const src = text.replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }   // удвоенная кавычка внутри поля
        else quoted = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const head = rows.shift();
  if (!head) return [];

  return rows
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/** Черновик объекта, собранный из строки выгрузки. */
export type ImportedDraft = {
  id: string;
  kind: string;
  deal_type: 'sale' | 'rent';
  address: string;
  city: string;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floors_total: number | null;
  price_minor: number;
  currency: 'USD' | 'KGS';
  photos: string[];
  description: string | null;
  actual_at: string;
};

export type Skipped = { id: string; why: string };

const DEALS: Record<string, 'sale' | 'rent'> = {
  'Продажа': 'sale',
  'Аренда': 'rent',
};

/** Вид объекта берётся из заголовка, а для коммерции — из раздела. */
const KINDS: Record<string, string> = {
  'Квартира': 'flat',
  'Комната': 'room',
  'Дом': 'house',
  'Таунхаус': 'townhouse',
  'Участок': 'land',
  'Гараж': 'garage',
  'Коммерция': 'commercial',
  'Коммерческая': 'commercial',
};

/** «150000 сом» и «145000 $» — в минорные единицы и код валюты. */
function price(raw: string): { minor: number; currency: 'USD' | 'KGS' } | null {
  const m = raw.replace(/ |\s/g, ' ').trim()
    .match(/^([\d][\d ]*)(?:[.,](\d{1,2}))?\s*(сом|som|kgs|\$|usd)$/i);
  if (!m) return null;

  const whole = Number(m[1].replace(/ /g, ''));
  const cents = Number((m[2] ?? '0').padEnd(2, '0'));
  if (!Number.isFinite(whole) || whole <= 0) return null;

  const unit = m[3].toLowerCase();
  const currency = unit === '$' || unit === 'usd' ? 'USD' : 'KGS';
  return { minor: whole * 100 + cents, currency };
}

/** «8/9 этаж» — восьмой из девяти. Бывает и просто «3». */
function floors(raw: string): { floor: number | null; total: number | null } {
  const m = raw.match(/^(\d{1,3})\s*(?:\/\s*(\d{1,3}))?/);
  if (!m) return { floor: null, total: null };
  const floor = Number(m[1]);
  const total = m[2] ? Number(m[2]) : null;
  return { floor: Number.isFinite(floor) ? floor : null, total };
}

function num(raw: string): number | null {
  if (!raw) return null;
  const v = Number(raw.replace(/ |\s/g, '').replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Строки выгрузки → черновики.
 *
 * Пропускается всё, чего нельзя разложить ЧЕСТНО: запрос вместо
 * объявления, снятое объявление, непонятный вид жилья, цена, которую не
 * прочитать, и цена за метр или за человека — такую нельзя класть в то же
 * поле, где лежит цена за объект.
 */
export function draftsFromCatalog(rows: CatalogRow[]): {
  drafts: ImportedDraft[];
  skipped: Skipped[];
} {
  const drafts: ImportedDraft[] = [];
  const skipped: Skipped[] = [];
  const skip = (id: string, why: string) => { skipped.push({ id: id || '(без id)', why }); };

  for (const r of rows) {
    const id = (r.id ?? '').trim();
    if (!id) { skip('', 'нет идентификатора'); continue; }

    const deal = DEALS[(r.deal ?? '').trim()];
    if (!deal) { skip(id, 'не объявление, а запрос'); continue; }

    if ((r.status ?? '').trim() !== 'опубликован') { skip(id, 'снято с публикации'); continue; }

    const per = (r.per ?? '').trim();
    if (per && per !== '/ мес') { skip(id, `цена ${per}, а не за объект`); continue; }

    const kind = KINDS[(r.title ?? '').trim()]
      ?? ((r.segment ?? '').trim() === 'Коммерция' ? 'commercial' : null);
    if (!kind) { skip(id, `неизвестный вид: ${(r.title ?? '').trim() || 'пусто'}`); continue; }

    const money = price(r.price ?? '');
    if (!money) { skip(id, `цену не прочитать: ${(r.price ?? '').trim() || 'пусто'}`); continue; }

    const district = (r.district ?? '').trim();
    const city = (r.city ?? '').trim() || 'Бишкек';
    const title = (r.title ?? '').trim();
    // Улицы в выгрузке нет вовсе — есть район. Адрес собирается из вида и
    // района («Дом, Азия Молл»): агент всё равно обязан его уточнить, пока
    // объект черновик, и такой адрес честно говорит, что уточнять.
    const address = [title, district].filter(Boolean).join(', ') || city;
    const { floor, total } = floors((r.floor ?? '').trim());
    const photo = (r.photo_url ?? '').trim();

    drafts.push({
      id,
      kind,
      deal_type: deal,
      address,
      city,
      zone: district || null,
      rooms: num(r.rooms ?? ''),
      area: num(r.area ?? ''),
      floor,
      floors_total: total,
      price_minor: money.minor,
      currency: money.currency,
      // Ссылка на чужой хостинг протухает, и это известно: Photo покажет
      // рисунок вместо битой картинки. Но агенту при правке черновика
      // ссылка нужнее пустоты — по ней он поймёт, что перезагрузить.
      photos: photo ? [photo] : [],
      description: (r.description ?? '').trim() || null,
      actual_at: (r.actuality_at || r.updated_at || r.created_at || '').trim()
        || new Date().toISOString(),
    });
  }

  return { drafts, skipped };
}
