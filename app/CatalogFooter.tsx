import { AGENCY_NAME, AGENCY_PHONES } from '@/lib/agency';

/**
 * Подвал публичной части. Телефоны повторяются здесь намеренно: человек,
 * долиставший карточку до конца, не должен возвращаться наверх за номером.
 */
export function CatalogFooter() {
  return (
    <footer className="pub-footer">
      <div className="pub-footer-in">
        <div className="col">
          <b>{AGENCY_NAME}</b>
          <span className="mini">Агентство недвижимости, Бишкек</span>
        </div>
        <div className="col">
          <b>Телефоны</b>
          {AGENCY_PHONES.map((p) => (
            <a key={p.href} href={p.href} className="pub-phone">{p.display}</a>
          ))}
        </div>
        <div className="col">
          <b>Агентам</b>
          <span className="mini">Кабинет и CRM — по входу для агентов.</span>
        </div>
      </div>
    </footer>
  );
}
