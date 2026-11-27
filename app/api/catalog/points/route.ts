import { NextResponse } from 'next/server';
import { catalogPoints } from '@/lib/db/catalog';
import { parseCatalogFilters } from '@/lib/catalog-params';
import { citiesOf } from '@/lib/geo';

/**
 * Точки для карты в видимой её части.
 *
 * Зачем маршрут. Карту двигают руками, и за каждым движением должна
 * приходить своя выборка — страницу ради этого не перезагрузишь.
 * Браузер в базу не ходит и ходить не может: за него это делает Worker,
 * и состав колонок задаёт витрина.
 *
 * Условия те же, что у страницы: обе стороны зовут одну функцию витрины.
 * Разойдись они — человек увидел бы на карте булавку, которой нет в
 * списке, и не понял бы, которая из частей врёт.
 */
export const dynamic = 'force-dynamic';

/** Число из строки запроса. Пусто или мусор — значит границы нет. */
function coord(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const f = parseCatalogFilters(params);

  const south = coord(url.searchParams.get('south'));
  const west = coord(url.searchParams.get('west'));
  const north = coord(url.searchParams.get('north'));
  const east = coord(url.searchParams.get('east'));
  // Рамка принимается только целиком: три числа из четырёх — это не
  // «почти рамка», а испорченный запрос, и отбор по нему дал бы не ту
  // выборку молча.
  const bbox = south !== null && west !== null && north !== null && east !== null
    ? { south, west, north, east }
    : null;

  try {
    const found = await catalogPoints({
      deal: f.deal ?? 'sale',
      term: f.anyTerm && f.deal === 'rent' ? 'any' : null,
      kind: f.kind,
      city: f.city,
      cities: f.region && !f.city ? citiesOf(f.region) : null,
      zone: f.zone,
      rooms: f.rooms,
      priceMin: f.priceMin,
      priceMax: f.priceMax,
    }, bbox);

    return NextResponse.json(found, { headers: { 'cache-control': 'no-store' } });
  } catch {
    // Карта переживёт пустой ответ: на ней останутся прежние булавки.
    return NextResponse.json({ points: [], total: 0, shown: 0 }, { status: 200 });
  }
}
