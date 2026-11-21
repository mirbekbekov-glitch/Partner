import { AGENCY_NAME, AGENCY_PHONES } from '@/lib/agency';
import { t, type Lang } from '@/lib/i18n';

/**
 * Подвал. Телефоны повторяются здесь намеренно: человек, долиставший
 * карточку до конца, не должен возвращаться наверх за номером.
 */
export function CatalogFooter({ lang }: { lang: Lang }) {
  const d = t(lang);
  return (
    <footer className="foot">
      <div className="foot-in wrap">
        <div>
          <h4>{AGENCY_NAME}</h4>
          <p className="fine">{d.agencyLine}</p>
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
