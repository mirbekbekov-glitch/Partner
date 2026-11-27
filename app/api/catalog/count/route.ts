import { NextResponse } from 'next/server';
import { catalogCount } from '@/lib/db/catalog';
import { parseCatalogFilters } from '@/lib/catalog-params';
import { citiesOf } from '@/lib/geo';

/**
 * Сколько объектов найдётся — для счётчика на кнопке «Найти».
 *
 * Зачем маршрут. Раньше кнопка считала сама, обращаясь к базе прямо из
 * браузера: у Supabase это было можно. У D1 так нельзя — до неё достаёт
 * только Worker, — и это к лучшему: браузер больше не ходит в базу вовсе,
 * а состав публичной выдачи задаётся в одном месте на сервере.
 *
 * Считает ТЕМИ ЖЕ условиями, что и страница: обе стороны зовут одну
 * функцию. Иначе число на кнопке разошлось бы с выдачей.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const f = parseCatalogFilters(params);

  try {
    const count = await catalogCount({
      // Нет параметра — покупка: та же умолчательная вкладка, что и на
      // странице каталога.
      deal: f.deal ?? 'sale',
      kind: f.kind,
      // Город и регион считались мимо счётчика: на кнопке стояло число
      // по всей стране, а выдача приходила по одному городу.
      city: f.city,
      cities: f.region && !f.city ? citiesOf(f.region) : null,
      zone: f.zone,
      rooms: f.rooms,
      priceMin: f.priceMin,
      priceMax: f.priceMax,
    });

    // Счётчик — подсказка, а не данные: кешировать его незачем, но и
    // хранить незачем тоже.
    return NextResponse.json({ count }, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    // Кнопка переживёт отсутствие числа: она останется «Показать».
    return NextResponse.json({ count: null }, { status: 200 });
  }
}
