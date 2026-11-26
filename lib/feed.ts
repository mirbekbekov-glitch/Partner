/**
 * Фид объявлений в формате Яндекс.Недвижимости (YRL).
 *
 * Зачем именно фид, а не коннектор к площадке. У house.kg и lalafo нет
 * открытой документации по выгрузке: ни описания API, ни требований к
 * файлу. Писать коннектор к неизвестному формату — значит получить код,
 * который выглядит готовым, а при первой встрече с площадкой рассыплется.
 *
 * Фид решает задачу с другой стороны. Это постоянный адрес, по которому
 * лежит список объявлений в общепринятом формате; площадке отдают ссылку,
 * и дальше она читает сама — без ключей, без договорённостей о протоколе,
 * без нашего кода на их стороне. Один и тот же адрес годится любой
 * площадке, которая умеет читать фиды, а не только этим двум.
 *
 * Строится ТОЛЬКО из витрины. Это не формальность: фид уходит наружу
 * целиком и навсегда, и попади в него поле агента или комиссия — забрать
 * назад уже нельзя. Витрина физически не отдаёт таких колонок.
 */
import 'server-only';
import { env } from 'cloudflare:workers';
import { catalogPage, type CatalogItem } from './db/catalog';
import { normalizePhone } from './db/normalize';

/**
 * Город.
 *
 * Допущение: в базе города нет, есть адрес и район. Площадке город нужен
 * обязательно, и сейчас он один — Бишкек. Появятся объекты в другом
 * городе — город придётся хранить в объекте, и это место сломается
 * заметно: все объявления уедут в Бишкек. Поэтому написано здесь, а не
 * спрятано в середине разметки.
 */
const CITY = 'Бишкек';
const COUNTRY = 'Кыргызстан';

/**
 * Вид объекта на языке площадки.
 *
 * Значения взяты из справочника YRL. «commercial» здесь НЕТ намеренно:
 * коммерческая недвижимость описывается там другим набором полей, а
 * точного значения я проверить не смог — справка Яндекса закрыта сетевой
 * политикой окружения. Выдуманное значение сделало бы невалидным весь
 * фид, а не одно объявление, поэтому коммерческие объекты в выгрузку не
 * попадают вовсе. Это записано в README как незакрытое место.
 */
const CATEGORY: Record<string, string> = {
  flat: 'квартира',
  room: 'комната',
  house: 'дом',
  townhouse: 'таунхаус',
  land: 'участок',
  garage: 'гараж',
};

/**
 * Контакт агентства в объявлении.
 *
 * Площадке нужен телефон: объявление без него — это объявление, по
 * которому нельзя позвонить. Но витрина телефонов не отдаёт вовсе, и
 * правильно делает: там телефоны СОБСТВЕННИКОВ, и утечь наружу они не
 * должны ни при каких обстоятельствах.
 *
 * Поэтому телефон здесь один и общий — агентства, а не агента. Он и по
 * сути верен: звонок с площадки приходит в агентство, а не конкретному
 * человеку, которого в выгрузке всё равно нет.
 *
 * Задан настройкой, а не в коде: номер меняется, а выкладка ради номера —
 * лишний повод тронуть код. Не задан — блок контакта не выводится вовсе:
 * пустой <phone> хуже отсутствующего, его площадка примет за настоящий.
 *
 * Внутри НАМЕРЕННО только phone и organization. В справочнике YRL у
 * контакта есть и другие поля со списком допустимых значений, но проверить
 * их я не смог — справка Яндекса закрыта сетевой политикой окружения, — а
 * неверное значение делает невалидным весь файл, а не одно объявление.
 */
function salesAgent(): string {
  const raw = (env as unknown as { FEED_PHONE?: string }).FEED_PHONE ?? '';
  const digits = normalizePhone(raw);
  if (digits.length !== 9) return '';

  const organization = (env as unknown as { FEED_ORG?: string }).FEED_ORG ?? '';

  return '    <sales-agent>\n'
    + `      <phone>+996${digits}</phone>\n`
    + (organization ? `      <organization>${esc(organization)}</organization>\n` : '')
    + '    </sales-agent>\n';
}

/** Больше этого за один запрос не собираем: Worker не резиновый. */
const MAX_OFFERS = 5000;
const PAGE = 60;

/**
 * Экранирование. Описание объекта пишет человек, и «<» в нём — обычное
 * дело; без экранирования одна такая скобка ломает весь файл, а не одно
 * объявление.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(name: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return `    <${name}>${esc(String(value))}</${name}>\n`;
}

function offer(item: CatalogItem, origin: string): string {
  const category = CATEGORY[item.kind];
  if (!category) return '';

  const url = `${origin}/ru/objects/${item.id}`;

  // Адреса снимков обязаны быть абсолютными: файл читает чужой сервер, и
  // «/photos/…» он разрешить не сможет.
  const images = item.photos
    .map((p) => (p.startsWith('http') ? p : `${origin}${p}`))
    .map((p) => `    <image>${esc(p)}</image>\n`)
    .join('');

  return `  <offer internal-id="${esc(item.id)}">\n`
    + tag('type', item.deal_type === 'sale' ? 'продажа' : 'аренда')
    + tag('property-type', 'жилая')
    + tag('category', category)
    + tag('url', url)
    + tag('creation-date', item.published_at)
    + tag('last-update-date', item.actual_at)
    + '    <location>\n'
    + tag('country', COUNTRY).replace('    <', '      <')
    + tag('locality-name', CITY).replace('    <', '      <')
    + (item.zone ? tag('sub-locality-name', item.zone).replace('    <', '      <') : '')
    + tag('address', item.address).replace('    <', '      <')
    + '    </location>\n'
    + '    <price>\n'
    + `      <value>${item.price}</value>\n`
    + `      <currency>${esc(item.currency)}</currency>\n`
    + '    </price>\n'
    + (item.area
      ? `    <area>\n      <value>${item.area}</value>\n      <unit>кв.м</unit>\n    </area>\n`
      : '')
    + tag('rooms', item.rooms)
    + tag('floor', item.floor)
    + tag('floors-total', item.floors_total)
    + tag('description', item.description)
    + salesAgent()
    + images
    + '  </offer>\n';
}

/** Весь фид строкой. */
export async function feedXml(origin: string): Promise<string> {
  const offers: string[] = [];

  // Витрина отдаёт страницами и не больше шестидесяти за раз — тот же
  // предел, что у каталога. Обходим его страницами, а не новым запросом
  // в обход витрины: свой запрос означал бы свой список колонок.
  for (let page = 1; offers.length < MAX_OFFERS; page++) {
    const { items, total } = await catalogPage({ page, pageSize: PAGE, sort: 'fresh' });
    for (const item of items) {
      const xml = offer(item, origin);
      if (xml) offers.push(xml);
    }
    if (items.length === 0 || page * PAGE >= total) break;
  }

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<realty-feed xmlns="http://webmaster.yandex.ru/schemas/feed/realty/2010-06">\n'
    + `  <generation-date>${new Date().toISOString()}</generation-date>\n`
    + offers.join('')
    + '</realty-feed>\n';
}
