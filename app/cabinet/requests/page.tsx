import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { KIND_LABEL } from '@/lib/request-labels';
import { RequestActions } from './RequestActions';

export const metadata = { title: 'Заявки клиентов' };

type Row = {
  id: string;
  deal: 'buy' | 'rent' | null;
  housing_type: string | null;
  rooms: number | null;
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
  public_consent: boolean;
  overdue: boolean;
  response_minutes: number;
};

const TABS: [string, string][] = [
  ['open', 'Свободные'],
  ['mine', 'Мои'],
  ['all', 'Все открытые'],
  ['closed', 'Закрытые'],
];

const DEAL: Record<string, string> = { buy: 'Купить', rent: 'Снять' };
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
  const tab = TABS.some(([v]) => v === one('tab')) ? one('tab')! : 'open';

  const supabase = await createClient();

  // Что показывать, решает лента: чужие контакты она уже закрыла, заявки
  // не своего направления не отдала. Здесь только срез по вкладке.
  let query = supabase
    .from('request_feed_v')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (tab === 'open')   query = query.eq('status', 'new');
  if (tab === 'mine')   query = query.eq('mine_state', 'mine');
  if (tab === 'all')    query = query.in('status', ['new', 'in_work']);
  if (tab === 'closed') query = query.in('status', ['closed', 'expired']);

  const { data, error } = await query;
  const rows = (data ?? []) as Row[];

  // Счётчик просроченных — главное число этой страницы. Заявка, пролежавшая
  // час без ответа, обычно уже не нужна, и это надо видеть сразу.
  const { data: waiting } = await supabase
    .from('request_feed_v')
    .select('overdue, mine_state, status')
    .in('status', ['new', 'in_work'])
    .limit(500);
  const open = waiting ?? [];
  const overdue = open.filter((r) => r.overdue).length;
  const free = open.filter((r) => r.mine_state === 'available').length;

  return (
    <>
      <h1>Заявки клиентов</h1>
      <p className="sub">
        Что ищут люди, не нашедшие объект в каталоге. Норматив первого
        ответа — час.
      </p>

      <div className="counters">
        <span className={overdue > 0 ? 'counter warn' : 'counter'}>
          Просрочено: <b>{overdue}</b>
        </span>
        <span className="counter">Свободных: <b>{free}</b></span>
      </div>

      <div className="tabs-row">
        {TABS.map(([v, label]) => (
          <Link key={v} href={`/cabinet/requests?tab=${v}`} className="chip"
                aria-current={tab === v ? 'true' : undefined}>
            {label}
          </Link>
        ))}
      </div>

      {error ? <p className="error">{error.message}</p> : null}

      {rows.length === 0 ? (
        <p className="empty">
          {tab === 'open' ? 'Свободных заявок нет.' : 'Здесь пока пусто.'}
        </p>
      ) : (
        rows.map((r) => (
          <div className="card" key={r.id}>
            <div className="rq-head">
              <b>
                {r.deal ? DEAL[r.deal] : 'Направление не указано'}
                {r.housing_type ? ` · ${KIND_LABEL[r.housing_type] ?? r.housing_type}` : ''}
                {r.rooms ? ` · ${r.rooms} комн.` : ''}
              </b>
              {r.overdue ? <span className="tag warn">просрочена</span> : null}
              {r.mine_state === 'mine' ? <span className="tag">моя</span> : null}
              {r.status === 'closed'
                ? <span className="tag">закрыта: {REASON[r.closed_reason ?? ''] ?? '—'}</span>
                : null}
              {r.status === 'expired' ? <span className="tag">в архиве</span> : null}
              <span className="key">
                {ago(r.response_minutes)}
                {r.first_response_at ? ' до ответа' : ' без ответа'}
              </span>
            </div>

            <p className="key">
              {[r.district ?? r.district_other,
                r.budget ? `до ${Math.round(r.budget).toLocaleString('ru-RU')} ${r.budget_currency === 'KGS' ? 'сом' : '$'}` : null,
              ].filter(Boolean).join(' · ') || 'Без дополнительных условий'}
            </p>

            {/* Контакт показывается только по праву: без согласия человека
                или на чужой взятой заявке здесь пусто, и это не ошибка. */}
            {r.phone ? (
              <p>
                <b>{r.name ?? 'Без имени'}</b> · <a href={`tel:${r.phone}`}>{r.phone}</a>
              </p>
            ) : (
              <p className="key">
                {r.public_consent
                  ? 'Контакт закрыт: заявку ведёт другой агент.'
                  : 'Человек не разрешил показывать телефон.'}
              </p>
            )}

            {r.wishes ? <p className="act-body">{r.wishes}</p> : null}

            {r.contact_id ? (
              <p className="key">
                Клиент заведён: <Link href={`/cabinet/contacts/${r.contact_id}`}>карточка</Link>
              </p>
            ) : null}

            {r.status === 'new' || r.status === 'in_work' ? (
              <RequestActions
                id={r.id}
                mine={r.mine_state}
                hasContact={Boolean(r.contact_id)}
                answered={Boolean(r.first_response_at)}
              />
            ) : null}
          </div>
        ))
      )}
    </>
  );
}
