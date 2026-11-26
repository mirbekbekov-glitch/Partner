import { AGENCY_NAME, AGENCY_PHONES } from '@/lib/agency';
import { placeName, t, type Lang } from '@/lib/i18n';
import { catalogCities } from '@/lib/db/catalog';

/**
 * Подвал. Телефоны повторяются здесь намеренно: человек, долиставший
 * карточку до конца, не должен возвращаться наверх за номером.
 *
 * Города спрашивает сам, а не принимает свойством. Подвал стоит на трёх
 * страницах, и протаскивать через каждую из них одно и то же значение —
 * три места, где о нём можно забыть. Запрос дешёвый: различные значения
 * одной проиндексированной колонки.
 */
export async function CatalogFooter({ lang }: { lang: Lang }) {
  const d = t(lang);
  const place = placeName(await catalogCities(), d);
  return (
    <footer className="foot">
      <div className="foot-in wrap">
        <div>
          <h4>{AGENCY_NAME}</h4>
          <p className="fine">{d.agencyLine(place)}</p>
        </div>
        <div>
          <h4>{d.phones}</h4>
          {AGENCY_PHONES.map((p) => (
            <a key={p.href} href={p.href} className="mono">{p.display}</a>
          ))}
        </div>
        <div>
          <h4>{d.forAgents}</h4>
          <p className="fine">{d.cabinetLine}</p>
        </div>
      </div>
    </footer>
  );
}
