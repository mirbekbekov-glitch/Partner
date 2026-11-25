import Link from 'next/link';
import { cabinetCounters } from '@/lib/db/cabinet';

export const metadata = { title: 'Кабинет' };

/**
 * Главная кабинета.
 *
 * Нужна не только для удобства: вход после ссылки из письма ведёт сюда, и
 * без этой страницы он упирался бы в 404.
 */
export default async function CabinetHome() {
  // Все числа одним запросом, а не девятью: девять обращений к базе ради
  // девяти чисел — это девять раз по кругу, и страница ощутимо ждёт.
  const n = await cabinetCounters();

  const objects = n?.objects ?? 0;
  const published = n?.published ?? 0;
  const needMandate = n?.need_mandate ?? 0;
  const contacts = n?.contacts ?? 0;
  const requirements = n?.requirements ?? 0;
  const openReq = n?.open_requirements ?? 0;
  const matches = n?.matches ?? 0;
  const openDeals = n?.open_deals ?? 0;
  const overdue = n?.tasks_overdue ?? 0;

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
          <span className="tile-n">{objects}</span>
          <span className="tile-t">объектов</span>
          <span className="key">{published} опубликовано</span>
        </Link>

        <Link className="tile" href="/cabinet/contacts">
          <span className="tile-n">{contacts}</span>
          <span className="tile-t">контактов</span>
          <span className="key">один человек — одна запись</span>
        </Link>

        <Link className="tile" href="/cabinet/requirements">
          <span className="tile-n">{requirements}</span>
          <span className="tile-t">потребностей</span>
          <span className="key">{openReq} в работе</span>
        </Link>

        <div className="tile">
          <span className="tile-n">{matches}</span>
          <span className="tile-t">подборов</span>
          <span className="key">связей объект ↔ клиент</span>
        </div>

        <Link className="tile" href="/cabinet/deals">
          <span className="tile-n">{openDeals}</span>
          <span className="tile-t">сделок в работе</span>
          <span className="key">комиссия до закрытия индикативна</span>
        </Link>
      </div>

      {overdue ? (
        <div className="card">
          <div className="row">
            <span className="warn">просрочено</span>
            <span>
              Задач с прошедшим сроком: <strong>{overdue}</strong>.
            </span>
            <Link href="/cabinet/activities">посмотреть →</Link>
          </div>
        </div>
      ) : null}

      {needMandate ? (
        <div className="card">
          <div className="row">
            <span className="warn">требует внимания</span>
            <span>
              Объектов без активного мандата: <strong>{needMandate}</strong>. Опубликовать
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
