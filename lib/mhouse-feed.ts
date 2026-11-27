/**
 * Фид объявлений для MHouse.
 *
 * Отдельный файл от feed.ts не по лени: у площадок разные форматы. Яндекс
 * ждёт латинские имена тегов и свой набор полей, MHouse — русские значения
 * строго из своих справочников. Свести их в один шаблон значило бы
 * получить файл, который не проходит проверку ни там, ни там.
 *
 * Строится ТОЛЬКО из витрины — по тому же правилу, что и фид Яндекса. Фид
 * уходит наружу целиком и навсегда; попади в него собственник, агент или
 * комиссия — забрать назад нельзя. Витрина таких колонок не отдаёт.
 *
 * Объявление без обязательного поля НЕ ВЫВОДИТСЯ. Площадка его всё равно
 * отклонит, но отклонённое объявление в отчёте выглядит как ошибка
 * выгрузки, а пропущенное — как незаполненная карточка, чем оно и
 * является. Чего не хватает, видно в кабинете.
 */
import 'server-only';
import { env } from 'cloudflare:workers';
import { catalogPage, type CatalogItem } from './db/catalog';
import { normalizePhone } from './db/normalize';
import {
  BUILDING_TYPE, CATEGORY, COMMERCIAL_TYPE, DEAL, DISTRICT, PARKING_TYPE,
  REGION, RENTAL_TERM, ROOM_LOCATION, SERIE, fromList, regionOf,
} from './mhouse';

/** Больше этого за один запрос не собираем: Worker не резиновый. */
const MAX_OFFERS = 5000;
const PAGE = 60;

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(name: string, value: string | number | null | undefined, pad = 4): string {
  if (value === null || value === undefined || value === '') return '';
  return `${' '.repeat(pad)}<${name}>${esc(String(value))}</${name}>\n`;
}

/**
 * Контакт агентства.
 *
 * Телефон и имя площадка требует у каждого объявления. Телефон здесь
 * общий, агентства: витрина телефонов не отдаёт вовсе — там телефоны
 * СОБСТВЕННИКОВ, и наружу они не уходят ни при каких обстоятельствах.
 *
 * Имя — настройка FEED_NAME, иначе название агентства. Придумывать его в
 * коде нельзя: в объявлении оно показывается человеку, который звонит.
 *
 * Нет телефона или имени — нет и контакта, а без него площадка не примет
 * ни одного объявления. Тогда фид выходит пустым, и это честнее, чем
 * выгрузка с пустым <phone>, который площадка примет за настоящий.
 */
function salesAgent(): string | null {
  const raw = (env as unknown as { FEED_PHONE?: string }).FEED_PHONE ?? '';
  const organization = (env as unknown as { FEED_ORG?: string }).FEED_ORG ?? '';
  const name = ((env as unknown as { FEED_NAME?: string }).FEED_NAME ?? '').trim()
    || organization.trim();

  const phones = raw
    .split(/[,;\n]/)
    .map((part) => normalizePhone(part))
    .filter((digits) => digits.length === 9)
    .filter((digits, i, all) => all.indexOf(digits) === i);

  if (phones.length === 0 || !name) return null;

  return '    <sales-agent>\n'
    + tag('name', name, 6)
    + phones.map((d) => `      <phone>+996${d}</phone>\n`).join('')
    // Фид агентства: объявления подаёт агент, а не собственник. Это не
    // допущение — собственник своим доступом к кабинету не пользуется.
    + tag('owner-type', 'агент', 6)
    + tag('organization', organization, 6)
    + '    </sales-agent>\n';
}

/**
 * Комнатность на языке площадки.
 *
 * У неё это список, а не число: шесть и больше идут одним значением.
 * Свободную планировку мы не храним, поэтому её здесь нет.
 */
function roomsValue(rooms: number | null): string | null {
  if (rooms === null || rooms < 1) return null;
  return rooms >= 6 ? '6 и более' : String(rooms);
}

/**
 * Что нужно знать об объекте, чтобы судить о его готовности к выгрузке.
 *
 * Описан составом, а не ссылкой на тип витрины: ту же проверку зовёт
 * карточка в кабинете, а у неё свой запрос. Общий состав держит обе
 * стороны на одном наборе полей, и забыть одно из них молча не выйдет.
 */
export type FeedCandidate = {
  kind: string;
  deal_type: 'rent' | 'sale';
  city: string;
  description: string | null;
  photos: string[];
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floors_total: number | null;
  latitude: number | null;
  longitude: number | null;
  region: string | null;
  building_type: string | null;
  serie: string | null;
  land_area: number | null;
  rental_term: string | null;
  commercial_type: string | null;
  room_location: string | null;
  parking_type: string | null;
};

/**
 * Чего не хватает объявлению для публикации на площадке.
 *
 * Возвращает список незаполненных обязательных полей. Пустой список —
 * объявление можно выгружать. Тот же список показывается на карточке
 * объекта: агент должен видеть пробел в кабинете, а не узнавать о нём из
 * отчёта площадки через сутки.
 */
export function missingFields(item: FeedCandidate): string[] {
  const miss: string[] = [];
  const category = CATEGORY[item.kind];

  if (!category) return ['вид объекта площадке неизвестен'];
  if (item.latitude === null || item.longitude === null) miss.push('координаты');
  if (!regionOf(item.city, item.region)) miss.push('регион');
  if (!item.description) miss.push('описание');
  if (item.photos.length === 0) miss.push('фото');
  if (item.deal_type === 'rent' && !fromList(RENTAL_TERM, item.rental_term)) {
    miss.push('срок аренды');
  }

  if (category === 'квартира') {
    if (!roomsValue(item.rooms)) miss.push('комнат');
    if (!item.area) miss.push('площадь');
    if (item.floor === null) miss.push('этаж');
    if (item.floors_total === null) miss.push('этажей в доме');
    if (!fromList(BUILDING_TYPE, item.building_type)) miss.push('тип дома');
    if (!fromList(SERIE, item.serie)) miss.push('серия');
  }

  if (category === 'дом') {
    if (!roomsValue(item.rooms)) miss.push('комнат');
    if (!item.area) miss.push('площадь');
    if (!item.land_area) miss.push('площадь участка');
  }

  if (category === 'участок' && !item.land_area) miss.push('площадь участка');

  if (category === 'коммерческая недвижимость') {
    if (!fromList(COMMERCIAL_TYPE, item.commercial_type)) miss.push('вид коммерции');
    if (!item.area) miss.push('площадь');
  }

  if (category === 'комната') {
    if (!fromList(ROOM_LOCATION, item.room_location)) miss.push('где комната');
    if (!roomsValue(item.rooms)) miss.push('комнат');
    if (!item.area) miss.push('площадь');
    if (item.floor === null) miss.push('этаж');
    if (item.floors_total === null) miss.push('этажей в доме');
  }

  if (category === 'паркинг/гараж' && !fromList(PARKING_TYPE, item.parking_type)) {
    miss.push('паркинг или гараж');
  }

  return miss;
}

function offer(item: CatalogItem, agent: string, origin: string): string {
  if (missingFields(item).length > 0) return '';

  const category = CATEGORY[item.kind];
  const region = regionOf(item.city, item.region);

  // Адреса снимков обязаны быть абсолютными: файл читает чужой сервер, и
  // «/photos/…» он разрешить не сможет.
  const images = item.photos
    .map((p) => (p.startsWith('http') ? p : `${origin}${p}`))
    .map((p) => `    <image>${esc(p)}</image>\n`)
    .join('');

  return `  <offer internal-id="${esc(item.id)}">\n`
    + tag('type', DEAL[item.deal_type])
    + tag('category', category)
    + tag('creation-date', item.published_at)
    + tag('last-update-date', item.actual_at)
    + tag('url', `${origin}/ru/objects/${item.id}`)
    + '    <location>\n'
    + tag('region', region, 6)
    + tag('town', item.city, 6)
    + tag('district', fromList(DISTRICT, item.district), 6)
    // Микрорайон площадки — это наш район: «Асанбай», «6 микрорайон».
    // Отдельного поля в карточке нет намеренно. Пока оно было, агент
    // заполнял одно и то же дважды, а расходились эти два поля в первый
    // же раз, когда он поправил только одно: в поиске по сайту объект
    // стоял в Асанбае, а на площадке — в Джале. Колонка осталась ради
    // тех объектов, где её успели заполнить руками.
    + tag('micro-district', item.micro_district ?? item.zone, 6)
    + tag('address', item.address, 6)
    + tag('house-number', item.house_number, 6)
    + tag('latitude', item.latitude, 6)
    + tag('longitude', item.longitude, 6)
    + '    </location>\n'
    + agent
    + '    <price>\n'
    + `      <value>${item.price}</value>\n`
    + `      <currency>${esc(item.currency)}</currency>\n`
    + '    </price>\n'
    + tag('rental-term', fromList(RENTAL_TERM, item.rental_term))
    + tag('rooms', roomsValue(item.rooms))
    + tag('square', item.area)
    + tag('land-square', item.land_area)
    + tag('floor', item.floor)
    + tag('floors', item.floors_total)
    + tag('year', item.build_year)
    + tag('building-type', fromList(BUILDING_TYPE, item.building_type))
    + tag('serie', fromList(SERIE, item.serie))
    + tag('commercial-type', fromList(COMMERCIAL_TYPE, item.commercial_type))
    + tag('room-location', fromList(ROOM_LOCATION, item.room_location))
    + tag('parking-type', fromList(PARKING_TYPE, item.parking_type))
    + tag('description', item.description)
    + images
    + '  </offer>\n';
}

/** Весь фид строкой. */
export async function mhouseXml(origin: string): Promise<string> {
  const agent = salesAgent();
  const offers: string[] = [];

  // Контакта нет — выгружать нечего: площадка не примет ни одного
  // объявления без телефона и имени.
  if (agent) {
    for (let page = 1; offers.length < MAX_OFFERS; page++) {
      const { items, total } = await catalogPage({ page, pageSize: PAGE, sort: 'fresh' });
      for (const item of items) {
        const xml = offer(item, agent, origin);
        if (xml) offers.push(xml);
      }
      if (items.length === 0 || page * PAGE >= total) break;
    }
  }

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<realty-feed>\n'
    + `  <generation-date>${new Date().toISOString()}</generation-date>\n`
    + offers.join('')
    + '</realty-feed>\n';
}
