/**
 * Разметка объявления для машин: schema.org JSON-LD.
 *
 * Зачем она, если на странице и так есть цена и адрес: поисковик читает
 * вёрстку догадками, а разметку — однозначно. Без неё «35 000» в тексте
 * равно годится и на цену, и на площадь, и на номер дома.
 *
 * Тип RealEstateListing — это страница объявления, а не само жильё.
 * Поэтому жильё лежит внутри, в about, а цена — в offers: разделение не
 * формальность, иначе цена повиснет на странице, а не на объекте.
 *
 * Берём ТОЛЬКО поля витрины (`lib/db/catalog.ts`). Разметка уезжает наружу
 * целиком, в исходный код страницы, и попади сюда комиссия или собственник —
 * это была бы самая публичная утечка из возможных.
 */
import { siteUrl } from './site';
import { AGENCY_NAME } from './agency';

type Listing = {
  id: string;
  kind: string;
  deal_type: 'rent' | 'sale';
  address: string;
  city: string;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floors_total: number | null;
  price: number;
  currency: string;
  description: string | null;
  published_at: string;
};

/**
 * Вид объекта из базы → тип schema.org.
 *
 * Для жилья есть точные типы, для земли, коммерции и гаража подходящего
 * нет: Accommodation означает «место для проживания», и натягивать его на
 * участок — врать разметкой. Там остаётся Place.
 */
const SCHEMA_TYPE: Record<string, string> = {
  flat: 'Apartment',
  room: 'Room',
  house: 'House',
  townhouse: 'House',
  land: 'Place',
  commercial: 'Place',
  garage: 'Place',
};

/** Продажа и аренда различаются не ценой, а назначением сделки. */
const BUSINESS_FUNCTION = {
  sale: 'http://purl.org/goodrelations/v1#Sell',
  rent: 'http://purl.org/goodrelations/v1#LeaseOut',
} as const;

export function listingSchema(o: Listing, lang: string, title: string) {
  const url = siteUrl(`/${lang}/objects/${o.id}`);

  const about: Record<string, unknown> = {
    '@type': SCHEMA_TYPE[o.kind] ?? 'Place',
    name: o.address,
    address: {
      '@type': 'PostalAddress',
      streetAddress: o.address,
      // Город из объекта, а не из константы. Константа здесь была той же
      // ошибкой, что и в выгрузке на площадки: объект из Оша поисковик
      // увидел бы бишкекским — и показал бы его не тем людям.
      addressLocality: o.city,
      addressCountry: 'KG',
      ...(o.zone ? { addressRegion: o.zone } : {}),
    },
  };

  if (o.rooms) about.numberOfRooms = o.rooms;
  if (o.area) {
    about.floorSize = { '@type': 'QuantitativeValue', value: o.area, unitCode: 'MTK' };
  }
  if (o.floor) about.floorLevel = String(o.floor);
  if (o.floors_total) about.numberOfFloors = o.floors_total;

  return {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    url,
    name: title,
    datePosted: o.published_at,
    ...(o.description ? { description: o.description } : {}),
    about,
    offers: {
      '@type': 'Offer',
      url,
      price: o.price,
      priceCurrency: o.currency,
      businessFunction: BUSINESS_FUNCTION[o.deal_type],
      availability: 'https://schema.org/InStock',
      seller: { '@type': 'RealEstateAgent', name: AGENCY_NAME, url: siteUrl('/') },
    },
  };
}
