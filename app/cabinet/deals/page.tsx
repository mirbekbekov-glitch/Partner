import Link from 'next/link';
import {
  dealCounts, dealList, type DealListItem, type DealScope,
} from '@/lib/db/cabinet';
import { money, day, parseFilters, type Filters } from '@/lib/list-params';
import { SortTh } from '../SortTh';
import { Pager } from '../Pager';
import { Board } from './Board';

export const metadata = { title: 'Сделки' };

const BASE = '/cabinet/deals';

/**
 * Разделы стали вкладками.
 *
 * Раньше обе группы показывались сразу из одной выборки в двести строк:
 * на двести первой сделка просто перестала бы показываться. Теперь
 * вкладка листается страницами, а числа в подписях считает база.
 */
const TABS: [DealScope, string][] = [
  ['open', 'В работе'],
  ['done', 'Завершённые'],
];

/** Доска показывает этапы целиком, поэтому берёт больше одной страницы. */
const BOARD_SIZE = 200;

export const DEAL_STATUS_RU: Record<string, string> = {
  deposit: 'аванс',
  documents: 'документы',
  signing: 'подписание',
  settlement: 'расчёт',
  closed: 'закрыта',
  failed: 'сорвана',
};


export default async function DealsList({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const f = parseFilters(sp);
  const view = (Array.isArray(sp.view) ? sp.view[0] : sp.view) === 'board' ? 'board' : 'table';
  // Сделку видят только её стороны: предикат стоит в запросе. Суммы до
  // закрытия индикативны и считаются на лету, после закрытия отдаются
  // зафиксированные — записывать индикативные нельзя, записанные означали
  // бы, что деньги уже поделены.
  let rows: DealListItem[] = [];
  let total = 0;
  let counts = { open: 0, done: 0 };
  let error: string | null = null;

  const board = view === 'board';
  // Доска показывает этапы целиком: завершённых на ней нет, а идущие
  // нужны все сразу — колонка с половиной сделок вводила бы в заблуждение.
  const tab: DealScope = board
    ? 'open'
    : (TABS.find(([v]) => v === f.tab)?.[0] ?? 'open');

  try {
    const [listed, tallies] = await Promise.all([
      dealList(f.sort, f.dir, tab, board ? 1 : f.page, board ? BOARD_SIZE : null),
      dealCounts(),
    ]);
    rows = listed.rows;
    total = listed.total;
    counts = tallies;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Не удалось загрузить сделки.';
  }

  return (
    <>
      <h1>Сделки</h1>
      <p className="sub">
        Сделка создаётся только из подбора. Суммы до закрытия индикативны и считаются
        от текущей цены объекта.
      </p>

      <div className="tabs-row">
        {/* Вкладки списка и переключатель вида — один ряд: это один выбор
            «что показать», и разводить его по двум местам незачем. */}
        {TABS.map(([v, label]) => (
          <Link
            key={v}
            href={v === 'open' ? BASE : `${BASE}?tab=${v}`}
            className="chip"
            aria-current={!board && tab === v ? 'true' : undefined}
          >
            {label} {counts[v]}
          </Link>
        ))}
        <Link href={`${BASE}?view=board`} className="chip"
              aria-current={board ? 'true' : undefined}>
          Доской
        </Link>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {rows.length === 0 ? (
        <p className="empty">
          {counts.open + counts.done === 0
            ? 'Сделок пока нет. Сделка начинается с подбора — на карточке объекта или потребности.'
            : 'В этой вкладке пусто.'}
        </p>
      ) : board ? (
        <Board rows={rows} />
      ) : (
        <DealTable rows={rows} f={f} />
      )}

      {/* На доске страниц нет: она показывает этапы целиком. */}
      {board ? null : <Pager base={BASE} filters={{ ...f, tab }} total={total} />}
    </>
  );
}

/**
 * Таблица сделок.
 *
 * Колонок много, и это намеренно: сделку читают по деньгам — цена,
 * комиссия, доли сторон, — а их сравнивают между строками. На узком экране
 * таблица разбирается на карточки силами cabinet.css.
 */
function DealTable({ rows, f }: { rows: DealListItem[]; f: Filters }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <SortTh base={BASE} f={f} col="address" label="Объект" />
            <SortTh base={BASE} f={f} col="status" label="Статус" />
            <th>Клиент</th>
            <th>Listing</th>
            <th>Closing</th>
            <SortTh base={BASE} f={f} col="price" label="Цена" className="num" />
            <th className="num">Комиссия</th>
            <th className="num">Доли</th>
            <SortTh base={BASE} f={f} col="created" label="Начата" />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>
                <Link className="tbl-main" href={`/cabinet/deals/${d.id}`}>
                  {d.address}
                </Link>
                <span className="tbl-sub">
                  {d.deal_type === 'sale' ? 'продажа' : 'аренда'}
                  {!d.can_act ? ' · вы не участник' : ''}
                </span>
              </td>
              <td data-l="Статус">
                <span className="tag">{DEAL_STATUS_RU[d.status] ?? d.status}</span>
                {d.failure_reason ? (
                  <span className="tbl-sub">{d.failure_reason}</span>
                ) : null}
              </td>
              <td data-l="Клиент">
                {d.client_name ?? <span className="hidden-contact">скрыт</span>}
              </td>
              <td data-l="Listing">{d.listing_agent_name ?? '—'}</td>
              <td data-l="Closing">{d.closing_agent_name ?? '—'}</td>
              <td className="num" data-l={d.status === 'closed' ? 'Финальная цена' : 'Цена объекта'}>
                {money(d.final_price ?? d.object_price, d.currency)}
              </td>
              <td className="num" data-l="Комиссия">
                {money(d.commission_total, d.currency)}
                {d.is_indicative ? <span className="tbl-sub">индикативно</span> : null}
              </td>
              <td className="num" data-l="Доли">
                {money(d.listing_share, d.currency)}
                <span className="tbl-sub">/ {money(d.closing_share, d.currency)}</span>
              </td>
              <td className="nowrap" data-l="Начата">
                {day(d.created_at)}
                {d.closed_at ? (
                  <span className="tbl-sub">завершена {day(d.closed_at)}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
