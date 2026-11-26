import Link from 'next/link';
import { leadFeed } from '@/lib/db/cabinet';
import { day } from '@/lib/list-params';
import { LeadActions } from './LeadActions';

export const metadata = { title: 'Заявки' };

type Row = {
  id: string;
  object_id: string;
  name: string;
  phone: string;
  message: string | null;
  status: 'new' | 'in_work' | 'done' | 'spam';
  created_at: string;
  agent_id: string | null;
  address: string | null;
  agent_name: string | null;
};

const STATUS_RU: Record<string, string> = {
  new: 'новая',
  in_work: 'в работе',
  done: 'отработана',
  spam: 'спам',
};

export default async function Leads({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = raw && raw in STATUS_RU ? raw : null;

  // Видимость стоит в самом запросе: заявки по объектам, за которые
  // отвечает этот агент. Раньше её обеспечивала политика базы, и условия
  // здесь не было вовсе — теперь страховки нет, поэтому предикат общий и
  // живёт в lib/db/visibility.ts.
  let rows: Row[] = [];
  let error: string | null = null;

  try {
    rows = await leadFeed(status) as unknown as Row[];
  } catch (e) {
    error = e instanceof Error ? e.message : 'Не удалось загрузить заявки.';
  }

  return (
    <>
      <h1>Заявки</h1>
      <p className="sub">
        Заявки с сайта по объектам, которые ведёте вы. Телефон заявителя виден
        только вам и администратору.
      </p>

      <form className="filters" method="get">
        <select name="status" defaultValue={status ?? ''}>
          <option value="">любой статус</option>
          {Object.entries(STATUS_RU).map(([k, ru]) => (
            <option key={k} value={k}>{ru}</option>
          ))}
        </select>
        <button type="submit">Фильтр</button>
        {status ? (
          <Link href="/cabinet/leads" className="key reset">сбросить</Link>
        ) : null}
      </form>

      {error ? <p className="error">{error}</p> : null}

      {rows.length === 0 ? (
        <p className="empty">
          {status ? 'С таким статусом заявок нет.' : 'Заявок пока нет.'}
        </p>
      ) : (
        rows.map((l) => (
          <div className="card" key={l.id}>
            <div className="row">
              <strong>{l.name}</strong>
              {/* Телефон — то, ради чего заявка существует: показываем целиком
                  и сразу, без «показать номер». Сюда дошли только те, кому он
                  положен: остальным политика не отдала бы и строки. */}
              <a href={`tel:${l.phone.replace(/[^\d+]/g, '')}`}>{l.phone}</a>
              <span className="tag">{STATUS_RU[l.status]}</span>
              <span className="key">{day(l.created_at)}</span>
            </div>

            <div className="row" style={{ marginTop: 6 }}>
              <span className="key">объект</span>
              <Link href={`/cabinet/objects/${l.object_id}`}>
                {l.address ?? 'объект удалён'}
              </Link>
              {l.agent_name ? (
                <>
                  <span className="key">ведёт</span>
                  <span>{l.agent_name}</span>
                </>
              ) : null}
            </div>

            {l.message ? <p className="act-body">{l.message}</p> : null}

            <LeadActions leadId={l.id} status={l.status} />
          </div>
        ))
      )}
    </>
  );
}
