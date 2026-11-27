import Link from 'next/link';
import { requestCounts, requestFeed, type RequestTab } from '@/lib/db/requests';
import { parseFilters } from '@/lib/list-params';
import { Pager } from '../Pager';
import { KIND_LABEL, SPACE_LABEL, termLabel } from '@/lib/request-labels';
import { RequestActions } from './RequestActions';

export const metadata = { title: 'Заявки клиентов' };

const BASE = '/cabinet/requests';

type Row = {
  id: string;
  deal: 'buy' | 'rent' | null;
  /** Заполнено — заявку оставил собственник, а не ищущий. */
  offer_deal: 'sale' | 'rent' | null;
  address: string | null;
  housing_type: string | null;
  space_type: string | null;
  rooms: number | null;
  term_days_min: number | null;
  term_days_max: number | null;
  district: string | null;
  district_other: string | null;
  budget: number | null;
  budget_currency: string;
  status: 'new' | 'in_work' | 'closed' | 'expired';
  created_at: string;
  first_response_at: string | null;
  closed_reason: string | null;
  contact_id: string | null;
  agent_name: string | null;
  mine_state: 'available' | 'mine' | 'other';
  name: string | null;
  phone: string | null;
  wishes: string | null;
  public_consent_flag: boolean;
  overdue: boolean;
  response_minutes: number;
};

const TABS: [RequestTab, string][] = [
  ['open', 'Свободные'],
  ['offers', 'От собственников'],
  ['mine', 'Мои'],
  ['all', 'Все открытые'],
  ['closed', 'Закрытые'],
];

const DEAL: Record<string, string> = { buy: 'Купить', rent: 'Снять' };
/* Собственник предлагает, а не ищет: «Продаёт», а не «Купить». */
const OFFER: Record<string, string> = { sale: 'Продаёт', rent: 'Сдаёт' };
const REASON: Record<string, string> = {
  deal: 'довели до сделки', found_self: 'нашёл сам', changed_mind: 'передумал',
  no_answer: 'не дозвонились', spam: 'спам', other: 'другое',
};

/** «12 минут», «3 часа», «2 дня» — без точности, которой нет смысла. */
function ago(minutes: number): string {
  if (minutes < 60) return `${minutes} мин.`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} ч.`;
  return `${Math.round(minutes / (60 * 24))} дн.`;
}

export default async function Requests({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const tab = (TABS.find(([v]) => v === one('tab'))?.[0] ?? 'open') as RequestTab;

  // Что показывать, решает лента: чужие контакты она уже закрыла. Здесь
  // только срез по вкладке.
  const f = parseFilters(sp);

  let rows: Row[] = [];
  let total = 0;
  let overdue = 0;
  let free = 0;
  let offers = 0;
  let error: string | null = null;

  try {
    // Счётчики — главные числа этой страницы, и считает их база: страница
    // показывает двадцать строк, а норматив нарушают все.
    const [listed, counts] = await Promise.all([
      requestFeed(tab, f.page),
      requestCounts(),
    ]);
    rows = listed.rows;
    total = listed.total;
    overdue = counts.overdue;
    free = counts.free;
    offers = counts.offers;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Не удалось загрузить заявки.';
  }

  return (
    <>
      <h1>Заявки клиентов</h1>
      <p className="sub">
        Что ищут люди, не нашедшие объект в каталоге, — и что предлагают
        собственники. Норматив первого ответа — час на обе стороны.
      </p>

      <div className="counters">
        <span className={overdue > 0 ? 'counter warn' : 'counter'}>
          Просрочено: <b>{overdue}</b>
        </span>
        <span className="counter">Свободных: <b>{free}</b></span>
        {/* Заявки собственников считаются отдельно: это товар, а не спрос,
            и теряются они дороже. */}
        <span className="counter">От собственников: <b>{offers}</b></span>
      </div>

      <div className="tabs-row">
        {TABS.map(([v, label]) => (
          <Link key={v} href={`/cabinet/requests?tab=${v}`} className="chip"
                aria-current={tab === v ? 'true' : undefined}>
            {label}
          </Link>
        ))}
      </div>

      {error ? <p className="error">{error}</p> : null}

      {rows.length === 0 ? (
        <p className="empty">
          {tab === 'open' ? 'Свободных заявок нет.'
            : tab === 'offers' ? 'Собственники пока не оставляли заявок.'
            : 'Здесь пока пусто.'}
        </p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Что нужно</th>
                <th>Условия</th>
                <th>Контакт</th>
                <th>Пожелания</th>
                <th>Статус</th>
                <th>Ответ</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="tbl-main">
                      {r.offer_deal
                        ? OFFER[r.offer_deal]
                        : r.deal ? DEAL[r.deal] : 'Направление не указано'}
                      {/* Подробный вид, если он есть: «коммерческая» не
                          отвечает на вопрос, звонить по офисам или по
                          складам. Огрублённый — только для старых заявок,
                          заведённых до появления словаря. */}
                      {r.space_type
                        ? ` · ${SPACE_LABEL[r.space_type] ?? r.space_type}`
                        : r.housing_type
                          ? ` · ${KIND_LABEL[r.housing_type] ?? r.housing_type}`
                          : ''}
                      {r.rooms ? ` · ${r.rooms} комн.` : ''}
                      {termLabel(r.term_days_min, r.term_days_max)
                        ? ` · ${termLabel(r.term_days_min, r.term_days_max)}`
                        : ''}
                    </span>
                    {/* Сторона — первое, что должен увидеть агент: заявка
                        с объектом это будущий мандат, а не подбор. */}
                    {r.offer_deal ? <span className="tag">собственник</span> : null}
                    {r.address ? <span className="tbl-sub">{r.address}</span> : null}
                    {r.contact_id ? (
                      <span className="tbl-sub">
                        <Link href={`/cabinet/contacts/${r.contact_id}`}>
                          клиент заведён
                        </Link>
                      </span>
                    ) : null}
                  </td>
                  <td data-l="Условия">
                    {[
                      r.district ?? r.district_other,
                      // У собственника это цена, а не потолок бюджета:
                      // «до 80 000» о цене продажи читалось бы наоборот.
                      r.budget
                        ? `${r.offer_deal ? '' : 'до '}${Math.round(r.budget).toLocaleString('ru-RU')} ${r.budget_currency === 'KGS' ? 'сом' : '$'}`
                        : null,
                    ].filter(Boolean).join(' · ') || 'Без условий'}
                  </td>
                  {/* Контакт показывается только по праву: без согласия
                      человека или на чужой взятой заявке здесь пусто, и это
                      не ошибка. */}
                  <td data-l="Контакт">
                    {r.phone ? (
                      <>
                        <span className="tbl-main">{r.name ?? 'Без имени'}</span>
                        <span className="tbl-sub">
                          <a href={`tel:${r.phone}`}>{r.phone}</a>
                        </span>
                      </>
                    ) : (
                      <span className="key">
                        {r.public_consent_flag
                          ? 'ведёт другой агент'
                          : 'показывать телефон не разрешили'}
                      </span>
                    )}
                  </td>
                  <td data-l="Пожелания">
                    {r.wishes ? <span className="tbl-text">{r.wishes}</span> : '—'}
                  </td>
                  <td data-l="Статус">
                    {r.mine_state === 'mine' ? <span className="tag">моя</span> : null}
                    {r.status === 'closed' ? (
                      <span className="tag">
                        закрыта: {REASON[r.closed_reason ?? ''] ?? '—'}
                      </span>
                    ) : null}
                    {r.status === 'expired' ? <span className="tag">в архиве</span> : null}
                    {r.agent_name ? <span className="tbl-sub">{r.agent_name}</span> : null}
                  </td>
                  <td className="nowrap" data-l="Ответ">
                    {ago(r.response_minutes)}
                    <span className="tbl-sub">
                      {r.first_response_at ? 'до ответа' : 'без ответа'}
                    </span>
                    {r.overdue ? (
                      <span className="tbl-note"><span className="warn">просрочена</span></span>
                    ) : null}
                  </td>
                  <td data-l="Действия">
                    {r.status === 'new' || r.status === 'in_work' ? (
                      <RequestActions
                        id={r.id}
                        mine={r.mine_state}
                        hasContact={Boolean(r.contact_id)}
                        answered={Boolean(r.first_response_at)}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Вкладка подставляется в ссылки страниц: разбор фильтров её только
          переносит, а проверяет набор значений эта страница. */}
      <Pager base={BASE} filters={{ ...f, tab }} total={total} />
    </>
  );
}
