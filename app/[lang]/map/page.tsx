import type { Metadata } from 'next';
import { catalogPoints } from '@/lib/db/catalog';
import { parseCatalogFilters } from '@/lib/catalog-params';
import { citiesOf } from '@/lib/geo';
import { t, LANGS, type Lang } from '@/lib/i18n';
import { CatalogHeader } from '../../CatalogHeader';
import { CatalogMap } from '../../CatalogMap';

/**
 * Каталог на карте.
 *
 * Отдельной страницей, а не вкладкой внутри каталога: карта занимает
 * весь экран и живёт по своим правилам — её двигают, и выдача меняется
 * от движения, а не от нажатия «Найти». Смешав их в одной странице, мы
 * получили бы экран, который ведёт себя по-разному в зависимости от
 * невидимого состояния.
 *
 * Первая выборка приходит с сервера: карта открывается уже с булавками,
 * а не моргает пустотой, пока браузер сходит за данными. Дальше её
 * перечитывает сама карта, по рамке.
 *
 * Фильтры те же, что в каталоге, и приходят теми же параметрами ссылки:
 * ссылкой на «аренду в Асанбае на карте» можно поделиться.
 */

export const dynamic = 'force-dynamic';

export async function generateMetadata(
  { params }: { params: Promise<{ lang: string }> },
): Promise<Metadata> {
  const { lang: raw } = await params;
  const lang = (LANGS as readonly string[]).includes(raw) ? raw as Lang : 'ru';
  const d = t(lang);
  return {
    title: d.mapTitle,
    description: d.mapLead,
    alternates: {
      canonical: `/${lang}/map`,
      languages: Object.fromEntries(LANGS.map((l) => [l, `/${l}/map`])),
    },
  };
}

export default async function MapPage({
  params, searchParams,
}: {
  params: Promise<{ lang: Lang }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { lang } = await params;
  const d = t(lang);
  const f = parseCatalogFilters(await searchParams);
  const deal = f.deal ?? 'sale';

  // Первая выборка — без рамки: границ карты сервер ещё не знает, и
  // придумывать их нельзя. Карта сама подгонит масштаб под пришедшее.
  let found = { points: [], total: 0, shown: 0 } as Awaited<
    ReturnType<typeof catalogPoints>
  >;
  let failed = false;

  try {
    found = await catalogPoints({
      deal,
      term: f.anyTerm && deal === 'rent' ? 'any' : null,
      kind: f.kind,
      city: f.city,
      cities: f.region && !f.city ? citiesOf(f.region) : null,
      zone: f.zone,
      rooms: f.rooms,
      priceMin: f.priceMin,
      priceMax: f.priceMax,
    });
  } catch {
    failed = true;
  }

  // Те же параметры уходят карте: она допишет к ним границы и позовёт
  // маршрут. Собираем здесь, чтобы карта не разбирала фильтры заново.
  const query = new URLSearchParams();
  query.set('deal', deal);
  if (f.anyTerm && deal === 'rent') query.set('term', 'any');
  if (f.kind) query.set('kind', f.kind);
  if (f.region) query.set('region', f.region);
  if (f.city) query.set('city', f.city);
  if (f.zone) query.set('zone', f.zone);
  if (f.rooms) query.set('rooms', String(f.rooms));
  if (f.priceMin != null) query.set('from', String(f.priceMin));
  if (f.priceMax != null) query.set('to', String(f.priceMax));

  return (
    <>
      <CatalogHeader lang={lang} />
      {failed ? (
        <div className="wrap"><p className="error">{d.catalogDown}</p></div>
      ) : (
        <CatalogMap
          lang={lang}
          points={found.points}
          total={found.total}
          shown={found.shown}
          query={query.toString()}
          d={{
            moveSearch: d.mapMove,
            found: d.objectsCount,
            partial: d.mapPartial,
            empty: d.mapEmpty,
            loading: d.mapLoading,
            roomsShort: d.roomsShort,
            sqm: d.sqm,
            mln: d.mln,
            thd: d.thd,
            som: d.somShort,
          }}
        />
      )}
    </>
  );
}
