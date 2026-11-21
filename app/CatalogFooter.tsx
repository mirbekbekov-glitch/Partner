import { AGENCY_NAME, AGENCY_PHONES } from '@/lib/agency';
import { t, type Lang } from '@/lib/i18n';

/**
 * Подвал публичной части. Телефоны повторяются здесь намеренно: человек,
 * долиставший карточку до конца, не должен возвращаться наверх за номером.
 */
export function CatalogFooter({ lang }: { lang: Lang }) {
  const d = t(lang);
  return (
    <footer className="pub-footer">
      <div className="pub-footer-in">
        <div className="col">
          <b>{AGENCY_NAME}</b>
          <span className="mini">{d.agencyLine}</span>
        </div>
        <div className="col">
          <b>{d.phones}</b>
          {AGENCY_PHONES.map((p) => (
            <a key={p.href} href={p.href} className="pub-phone">{p.display}</a>
          ))}
        </div>
        <div className="col">
          <b>{d.forAgents}</b>
          <span className="mini">{d.cabinetLine}</span>
        </div>
      </div>
    </footer>
  );
}
