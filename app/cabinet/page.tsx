import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export const metadata = { title: 'Кабинет' };

/**
 * Главная кабинета.
 *
 * Нужна не только для удобства: /auth/confirm после входа ведёт на /cabinet,
 * и без этой страницы вход упирался в 404.
 */
export default async function CabinetHome() {
  const supabase = await createClient();

  // head: true — нужны только счётчики, строки тянуть незачем.
  const [objects, published, needMandate, requirements, openReq, matches, openDeals, overdue] =
    await Promise.all([
    supabase.from('objects').select('id', { count: 'exact', head: true }),
    supabase.from('objects').select('id', { count: 'exact', head: true })
      .eq('publication_state', 'published'),
    supabase.from('object_list_v').select('id', { count: 'exact', head: true })
      .is('active_mandate_id', null),
    supabase.from('requirements').select('id', { count: 'exact', head: true }),
    supabase.from('requirements').select('id', { count: 'exact', head: true })
      .not('status', 'in', '("closed","lost")'),
    supabase.from('matches').select('id', { count: 'exact', head: true }),
    supabase.from('deals').select('id', { count: 'exact', head: true })
      .not('status', 'in', '("closed","failed")'),
    supabase.from('activity_feed_v').select('id', { count: 'exact', head: true })
      .eq('mine', true).eq('overdue', true),
  ]);

  return (
    <>
      <div className="head">
        <h1>Кабинет</h1>
        <span className="actions">
          <Link className="btn" href="/cabinet/objects/new">Новый объект</Link>
          <Link className="btn ghostlink" href="/cabinet/requirements/new">
            Новая потребность
          </Link>
        </span>
      </div>
      <p className="sub">Объекты, потребности и подборы между ними.</p>

      <div className="tiles">
        <Link className="tile" href="/cabinet/objects">
          <span className="tile-n">{objects.count ?? 0}</span>
          <span className="tile-t">объектов</span>
          <span className="key">{published.count ?? 0} опубликовано</span>
        </Link>

        <Link className="tile" href="/cabinet/requirements">
          <span className="tile-n">{requirements.count ?? 0}</span>
          <span className="tile-t">потребностей</span>
          <span className="key">{openReq.count ?? 0} в работе</span>
        </Link>

        <div className="tile">
          <span className="tile-n">{matches.count ?? 0}</span>
          <span className="tile-t">подборов</span>
          <span className="key">связей объект ↔ клиент</span>
        </div>

        <Link className="tile" href="/cabinet/deals">
          <span className="tile-n">{openDeals.count ?? 0}</span>
          <span className="tile-t">сделок в работе</span>
          <span className="key">комиссия до закрытия индикативна</span>
        </Link>
      </div>

      {overdue.count ? (
        <div className="card">
          <div className="row">
            <span className="warn">просрочено</span>
            <span>
              Задач с прошедшим сроком: <strong>{overdue.count}</strong>.
            </span>
            <Link href="/cabinet/activities">посмотреть →</Link>
          </div>
        </div>
      ) : null}

      {needMandate.count ? (
        <div className="card">
          <div className="row">
            <span className="warn">требует внимания</span>
            <span>
              Объектов без активного мандата: <strong>{needMandate.count}</strong>. Опубликовать
              их нельзя, пока договор с собственником не заключён.
            </span>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <Link href="/cabinet/objects?state=draft">посмотреть черновики →</Link>
          </div>
        </div>
      ) : null}
    </>
  );
}
