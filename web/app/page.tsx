import type { Metadata } from "next";
import { ObjectCard } from "./components";
import { Hero } from "./Hero";
import { PAGE_SIZE, fetchCatalog, fetchFacets, parseFilters } from "@/lib/catalog";
import { DEAL_LABEL, KIND_PLURAL, plural, withParam } from "@/lib/format";

type SearchParams = Record<string, string | string[] | undefined>;

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const [page, facets] = await Promise.all([
    fetchCatalog(filters),
    fetchFacets(),
  ]);

  const hasFilters =
    filters.deal !== null ||
    filters.kind !== null ||
    filters.zone !== null ||
    filters.rooms !== null ||
    filters.priceMin !== null ||
    filters.priceMax !== null;

  const pageHref = (n: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      const first = Array.isArray(v) ? v[0] : v;
      if (first && k !== "page") qs.set(k, first);
    }
    if (n > 1) qs.set("page", String(n));
    const query = qs.toString();
    return query ? `/?${query}` : "/";
  };

  return (
    <>
      <div className="hero-band">
        <div className="wrap">
          <Hero total={page.total} />
        </div>
      </div>

      <div className="wrap">
      {/* Панель поиска «наезжает» на герой — так она на макете, и так она
          первое, что видно: за поиском сюда и приходят. */}
      <div className="searchbox">
      <nav className="deal-tabs" aria-label="Тип сделки">
        <a href={withParam(params, "deal", null)} aria-current={!filters.deal}>
          Всё
        </a>
        <a
          href={withParam(params, "deal", "sale")}
          aria-current={filters.deal === "sale"}
        >
          Купить
        </a>
        <a
          href={withParam(params, "deal", "rent")}
          aria-current={filters.deal === "rent"}
        >
          Снять
        </a>
      </nav>

      {/* Обычная форма с методом GET: фильтры живут в адресе страницы,
          поэтому ссылку можно отправить, а поисковик — проиндексировать.
          Клиентского кода для этого не нужно вовсе. */}
      <form className="filters" method="get" action="/">
        {filters.deal && <input type="hidden" name="deal" value={filters.deal} />}

        <div className="field">
          <label htmlFor="kind">Тип</label>
          <select id="kind" name="kind" defaultValue={filters.kind ?? ""}>
            <option value="">Любой</option>
            {facets.kinds.map((k) => (
              <option key={k} value={k}>
                {KIND_PLURAL[k]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="zone">Район</label>
          <select id="zone" name="zone" defaultValue={filters.zone ?? ""}>
            <option value="">Любой</option>
            {facets.zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="rooms">Комнат от</label>
          <select id="rooms" name="rooms" defaultValue={filters.rooms ?? ""}>
            <option value="">Любое</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="price_min">Цена от</label>
          <input
            id="price_min"
            name="price_min"
            type="number"
            min="0"
            step="100"
            inputMode="numeric"
            defaultValue={filters.priceMin ?? ""}
          />
        </div>

        <div className="field">
          <label htmlFor="price_max">до</label>
          <input
            id="price_max"
            name="price_max"
            type="number"
            min="0"
            step="100"
            inputMode="numeric"
            defaultValue={filters.priceMax ?? ""}
          />
        </div>

        <div className="field">
          <label htmlFor="sort">Сортировка</label>
          <select id="sort" name="sort" defaultValue={filters.sort}>
            <option value="fresh">Сначала подтверждённые</option>
            <option value="price_asc">Цена по возрастанию</option>
            <option value="price_desc">Цена по убыванию</option>
            <option value="area_desc">Площадь по убыванию</option>
          </select>
        </div>

        <button type="submit">Найти</button>
        {hasFilters && (
          <a className="reset" href="/">
            Сбросить
          </a>
        )}
      </form>
      </div>

      {/* Районы строкой: самый частый вопрос к каталогу — «что есть в
          Центре», и ради него не стоит лезть в выпадающий список. */}
      {facets.zones.length > 0 && (
        <nav className="zonechips" aria-label="Районы">
          {facets.zones.slice(0, 8).map((z) => (
            <a key={z} href={withParam(params, "zone", filters.zone === z ? null : z)}
               aria-current={filters.zone === z}>
              {z}
            </a>
          ))}
        </nav>
      )}

      <p className="count">
        {page.total > 0
          ? `${page.total} ${plural(page.total, "объект", "объекта", "объектов")} в каталоге`
          : "Ничего не найдено"}
        {page.pages > 1 && ` · страница ${page.page} из ${page.pages}`}
      </p>

      {page.items.length === 0 ? (
        <div className="empty">
          <strong>Под эти условия ничего нет</strong>
          Попробуйте расширить диапазон цены или снять фильтр по району.
          {hasFilters && (
            <>
              {" "}
              <a className="reset" href="/">
                Показать весь каталог
              </a>
            </>
          )}
        </div>
      ) : (
        <div className="grid">
          {page.items.map((item) => (
            <ObjectCard key={item.id} item={item} />
          ))}
        </div>
      )}

      {page.pages > 1 && (
        <nav className="pager" aria-label="Страницы каталога">
          {page.page > 1 && <a href={pageHref(page.page - 1)}>Назад</a>}
          {Array.from({ length: page.pages }, (_, i) => i + 1)
            .filter(
              (n) =>
                n === 1 ||
                n === page.pages ||
                Math.abs(n - page.page) <= 1,
            )
            .map((n, idx, arr) => (
              <span key={n} style={{ display: "contents" }}>
                {idx > 0 && arr[idx - 1] !== n - 1 && <span>…</span>}
                <a href={pageHref(n)} aria-current={n === page.page}>
                  {n}
                </a>
              </span>
            ))}
          {page.page < page.pages && <a href={pageHref(page.page + 1)}>Вперёд</a>}
        </nav>
      )}

      {page.total > PAGE_SIZE && (
        <p className="count">
          Показываем по {PAGE_SIZE} объектов на странице.
        </p>
      )}
      </div>

      {/* Тёмная полоса в конце. Здесь не реклама, а честный ответ на то, чего
          в каталоге нет: половина объектов города в него не попадает, потому
          что собственник ещё не подписал договор. */}
      <section className="cta-band">
        <div className="wrap">
          <div>
            <p className="kicker dark">Не нашли подходящее</p>
            <h2>Опишите, что ищете — искать будут агенты</h2>
            <p>
              В каталоге только то, что уже подтверждено договором. Остальное
              агентства знают, но не публикуют: собственник не всегда готов,
              цена обсуждается. Заявка открывает им ваш запрос.
            </p>
            <a className="pill" href="/cabinet">Оставить заявку →</a>
            <p className="cta-note">
              Пока заявка с сайта принимается через агентов: публичной формы
              здесь ещё нет, и делать вид, что она есть, незачем.
            </p>
          </div>
          <ol className="steps">
            <li><b>Вы описываете</b><span>что ищете, в каком районе и за сколько</span></li>
            <li><b>Заявку видят агенты</b><span>все, у кого есть подходящий объект</span></li>
            <li><b>Вам приносят варианты</b><span>с договором, ценой и датой подтверждения</span></li>
          </ol>
        </div>
      </section>
    </>
  );
}
