import 'server-only';
import { env } from 'cloudflare:workers';

/**
 * Откуда берутся плитки карты.
 *
 * Адрес НЕ вшит в код нарочно — этого прямо просит сама политика
 * OpenStreetMap: «Avoid hard-coding the tile URL; allow switching
 * without needing a software update». Причина у неё серьёзнее, чем
 * удобство: доступ к их серверу может быть отозван без предупреждения,
 * и в этот день карта должна чиниться настройкой, а не выкладкой.
 *
 * Политика (operations.osmfoundation.org/policies/tiles/, прочитана, а
 * не вспомнена) не устанавливает ни лимита запросов, ни числа плиток в
 * сутки. Она говорит другое, и для нас это важнее цифры:
 *
 *   «Commercial services, or those that seek donations, should be
 *   especially aware that access may be withdrawn at any point: you may
 *   no longer be able to serve your paying customers if access is
 *   withdrawn.»
 *
 * То есть пользоваться их сервером можно и коммерческим сайтам, но
 * обещаний нам никто не давал. Пока объявлений немного — это разумный
 * выбор: он бесплатен и ничего не требует. Когда карта станет заметной
 * частью трафика, источник меняется значением MAP_TILES, и код об этом
 * знать не должен.
 *
 * Что мы обязаны делать, пока берём плитки у них (и делаем):
 *   — ровно адрес https://tile.openstreetmap.org/{z}/{x}/{y}.png;
 *   — видимая подпись «© OpenStreetMap contributors»;
 *   — не мешать браузеру слать Referer (своего Referrer-Policy у нас
 *     нет — проверено, не вспомнено);
 *   — не заказывать плитки впрок и не давать «скачать район».
 * Браузер с настройками по умолчанию остальному удовлетворяет сам —
 * это сказано в самой политике.
 *
 * Чего мы НЕ делаем: не ставим свой кеширующий прокси. Политика его «не
 * рекомендует», а пользы он не даёт: от отзыва доступа не спасает, зато
 * добавляет нам обязанность слать опознаваемый User-Agent и хранить
 * чужие плитки.
 */

export type TileSource = { url: string; attribution: string };

const OSM: TileSource = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© OpenStreetMap contributors',
};

/**
 * Источник плиток: из настройки или OSM по умолчанию.
 *
 * Подпись меняется вместе с адресом: у другого поставщика своя, и
 * оставить чужую — нарушить уже его лицензию. Поэтому одно без другого
 * не принимается: задан адрес без подписи — берём OSM целиком, чтобы на
 * карте не оказалось плиток без указания источника.
 */
export function tileSource(): TileSource {
  const vars = env as unknown as {
    MAP_TILES?: string;
    MAP_TILES_ATTRIBUTION?: string;
  };
  return pickTiles(vars.MAP_TILES, vars.MAP_TILES_ATTRIBUTION);
}

/**
 * Разбор настройки — отдельно от обращения к платформе, чтобы его можно
 * было проверить.
 *
 * Требуем https и {z} в адресе: подстановка без {z} — не шаблон плиток,
 * а чей-то недописанный адрес, и карта молча осталась бы серой.
 */
export function pickTiles(
  url: string | undefined, attribution: string | undefined,
): TileSource {
  const u = (url ?? '').trim();
  const a = (attribution ?? '').trim();
  if (!u.startsWith('https://') || !u.includes('{z}') || !a) return OSM;
  return { url: u, attribution: a };
}

export const OSM_TILES = OSM;
