import Link from 'next/link';
import { cabinetCounters, myActivities, leadFeed, recentActivity } from '@/lib/db/cabinet';
import { KIND_RU } from '@/lib/activity-kinds';

export const metadata = { title: 'Кабинет' };

/* Куда ведёт запись. Тот же набор, что на странице задач: контакт, подбор
   и мандат ссылкой не открываются и там. */
const ENTITY_PATH: Record<string, string> = {
  object: 'objects',
  requirement: 'requirements',
  deal: 'deals',
};

const LEAD_STATUS_RU: Record<string, string> = {
  new: 'новая', in_work: 'в работе', done: 'отработана', spam: 'спам',
};

const when = (v: string | null) =>
  v == null ? '' : new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Главная кабинета.
 *
 * Нужна не только для удобства: вход после ссылки из письма ведёт сюда, и
 * без этой страницы он упирался бы в 404.
 */
export default async function CabinetHome() {
  // Числа — одним запросом, а три списка — параллельно с ними и друг с
  // другом: последовательно это было бы четыре раза по кругу до первой
  // отрисовки.
  const [n, tasks, leads, recent] = await Promise.all([
    cabinetCounters(),
    myActivities(),
    // Со страницей: leadFeed теперь отдаёт срез со счётчиком, а не массив.
    leadFeed('new', 1),
    recentActivity(),
  ]);

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

      {/* Ниже плиток страница была пуста, и агент начинал день с экрана,
          с которого нечего делать. Здесь три списка, за которыми он сюда и
          приходит: что он должен, что ему пришло и что он уже сделал.
          Каждый — выжимка; полный список за ссылкой. */}
      <div className="grid2 cab-digest">
        <section className="card">
          <div className="head">
            <h2>Задачи</h2>
            <Link className="key" href="/cabinet/activities">все задачи →</Link>
          </div>
          {tasks.length === 0 ? (
            <p className="key">
              Незакрытых задач нет. Звонок, показ или задача записывается на
              карточке объекта, потребности или сделки.
            </p>
          ) : (
            <ul className="digest">
              {tasks.slice(0, 5).map((a) => (
                <li key={a.id}>
                  <div className="row">
                    <span className="tag">{KIND_RU[a.kind] ?? a.kind}</span>
                    {a.overdue ? <span className="warn">просрочено</span> : null}
                    {a.due_at ? <span className="key">срок {when(a.due_at)}</span> : null}
                  </div>
                  <div className="digest-main">
                    {a.entity_title && ENTITY_PATH[a.entity_type] ? (
                      <Link href={`/cabinet/${ENTITY_PATH[a.entity_type]}/${a.entity_id}`}>
                        {a.entity_title}
                      </Link>
                    ) : (
                      <span>{a.entity_title ?? 'запись'}</span>
                    )}
                    {a.body ? <span className="key"> — {a.body}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {tasks.length > 5 ? (
            <p className="key">и ещё {tasks.length - 5}</p>
          ) : null}
        </section>

        <section className="card">
          <div className="head">
            <h2>Новые заявки</h2>
            <Link className="key" href="/cabinet/leads">все заявки →</Link>
          </div>
          {leads.rows.length === 0 ? (
            <p className="key">
              Неразобранных заявок нет. Заявка приходит с карточки объекта на
              сайте — отвечать на неё норматив обещает в течение часа.
            </p>
          ) : (
            <ul className="digest">
              {leads.rows.slice(0, 5).map((l) => (
                <li key={l.id}>
                  <div className="row">
                    <span className="tag">{LEAD_STATUS_RU[l.status] ?? l.status}</span>
                    <span className="key">{when(l.created_at)}</span>
                  </div>
                  <div className="digest-main">
                    <strong>{l.name}</strong>{' '}
                    {/* Телефон целиком и сразу: сюда дошли только те, кому он
                        положен, — выдача заявок ограничена объектами агента. */}
                    <a href={`tel:${l.phone.replace(/[^\d+]/g, '')}`}>{l.phone}</a>
                    {l.address ? (
                      <>
                        <span className="key"> · </span>
                        <Link href={`/cabinet/objects/${l.object_id}`}>{l.address}</Link>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {leads.total > 5 ? (
            <p className="key">и ещё {leads.total - 5}</p>
          ) : null}
        </section>
      </div>

      <section className="card cab-digest">
        {/* Ссылки «все задачи» здесь нет намеренно: она уже стоит в списке
            дел выше и вела бы туда же. */}
        <div className="head">
          <h2>Последние действия</h2>
        </div>
        {recent.length === 0 ? (
          <p className="key">
            Закрытых записей пока нет. Здесь появится то, что вы отметили
            выполненным, и заметки.
          </p>
        ) : (
          <ul className="digest">
            {recent.map((a) => (
              <li key={a.id}>
                <div className="row">
                  <span className="tag">{KIND_RU[a.kind] ?? a.kind}</span>
                  {a.done ? (
                    <span className="key">выполнено {when(a.done_at)}</span>
                  ) : (
                    <span className="key">записано {when(a.created_at)}</span>
                  )}
                </div>
                <div className="digest-main">
                  {a.entity_title && ENTITY_PATH[a.entity_type] ? (
                    <Link href={`/cabinet/${ENTITY_PATH[a.entity_type]}/${a.entity_id}`}>
                      {a.entity_title}
                    </Link>
                  ) : (
                    <span>{a.entity_title ?? 'запись'}</span>
                  )}
                  {a.body ? <span className="key"> — {a.body}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
