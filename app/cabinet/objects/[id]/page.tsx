import Link from 'next/link';
import { STATE_RU } from '@/lib/object-state';
import { notFound } from 'next/navigation';
import {
  activeMandateOf, activityFeed, objectCard, objectMatches, openRequirements,
} from '@/lib/db/cabinet';
import { approvedColleagues } from '@/lib/db/agents';
import { canEditObject } from '@/lib/db/access';
import { inFeed } from '@/lib/feed';
import { estimate, marketLookalikes } from '@/lib/db/market';
import { exportState } from '@/lib/db/feed-log';
import { awayFromMarket } from '@/lib/market/valuation';
import { missingFields } from '@/lib/mhouse-feed';
import { Activities, type ActivityRow } from '../../Activities';
import { CreateMatchForm } from '../../CreateMatchForm';
import { ContactCell } from '../../HiddenContact';
import { ObjectActions } from '../ObjectActions';
import { CommissionForm } from '../CommissionForm';
import { StartDealButton } from '../../deals/StartDealButton';
import { MatchStatus } from '../../MatchStatus';
import { TransferForm, type Colleague } from '../../TransferForm';
import { transferObject } from '../../transfer-actions';

const money = (v: number | null, c = 'USD') =>
  v == null ? '—' : `${new Intl.NumberFormat('ru-RU').format(v)} ${c}`;

/** Зоны потребности лежат JSON-строкой: в базе нет типа массива. */
const zonesOf = (v: string | null): string[] => {
  try {
    const parsed: unknown = JSON.parse(v ?? '[]');
    return Array.isArray(parsed) ? parsed as string[] : [];
  } catch {
    return [];
  }
};

const when = (v: string | null) =>
  v == null ? '—' : new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

export default async function ObjectCard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [object, matches, requirements, mandate, canEdit, colleagues, activities] =
    await Promise.all([
      objectCard(id),
      objectMatches(id),
      // Открытые потребности для кнопки «создать подбор». Направление
      // сверяет слой доступа, но незачем показывать заведомо негодные.
      openRequirements(),
      activeMandateOf(id),
      // Право на правку считает предикат: про listing-агента активного
      // мандата и про админа в коде страницы судить нечем.
      canEditObject(id),
      approvedColleagues(),
      activityFeed('object', id),
    ]);

  if (!object) notFound();

  const rows = matches;
  const alreadyMatched = new Set(rows.map((r) => r.requirement_id));

  const options = requirements
    .filter((r) => r.deal_type === object.deal_type && !alreadyMatched.has(r.id))
    .map((r) => ({
      id: r.id,
      label: `${money(r.budget_min, object.currency)} – ${money(r.budget_max, object.currency)}${
        zonesOf(r.zones).length ? ` · ${zonesOf(r.zones).join(', ')}` : ''
      }`,
    }));

  const feedGaps = missingFields(object);

  // Проверка по площадкам. Два разных вопроса, и оба про один объект:
  // не висит ли он уже где-то ещё, и не выбивается ли цена из рынка.
  //
  // Считается ПОСЛЕ загрузки объекта, а не вместе с ней: обоим нужен сам
  // объект. Отказ индекса не должен ронять карточку — объект существует
  // независимо от того, успел ли обход собрать рынок.
  // Что известно о выгрузке на площадку. Три разных утверждения, и
  // путать их нельзя: «попал в выгрузку» и «площадка забрала фид» —
  // наши факты, а «объявление опубликовано» знает только площадка.
  const exported = await exportState(object.id).catch(() => null);

  const KINDS_WITH_MARKET = ['flat', 'room', 'house', 'land'];
  const lookalikes = await marketLookalikes(object).catch(() => null);
  const priced = object.area && KINDS_WITH_MARKET.includes(object.kind)
    ? await estimate({
      deal: object.deal_type,
      kind: object.kind as 'flat' | 'room' | 'house' | 'land',
      city: object.city,
      zone: object.zone,
      rooms: object.rooms,
      area: object.area,
      currency: object.currency === 'KGS' ? 'KGS' : 'USD',
      period: object.deal_type === 'rent' ? 'month' : null,
    }).catch(() => null)
    : null;

  const away = priced?.valuation
    ? awayFromMarket(Math.round(object.price * 100), priced.valuation)
    : null;

  return (
    <>
      <h1>{object.address}</h1>
      <p className="sub">
        {object.deal_type === 'sale' ? 'Продажа' : 'Аренда'} · {money(object.price, object.currency)}
        {object.zone ? ` · ${object.zone}` : ''}
        {object.rooms ? ` · ${object.rooms} комн.` : ''}
        {object.area ? ` · ${object.area} м²` : ''}
      </p>

      <div className="card">
        <div className="row">
          <span className="key">Публикация</span>
          <span className="tag">{STATE_RU[object.publication_state] ?? object.publication_state}</span>
          <span className="key">Опубликован</span>
          <span>{when(object.published_at)}</span>
          <span className="key">Актуально на</span>
          <span>{when(object.actual_at)}</span>
        </div>
        {/* Выгрузка на площадки. Две разные причины не доехать, и обе
            должны быть видны тому, кто может их закрыть: вид объекта,
            который яндексовский фид не берёт, и незаполненные поля, без
            которых объявление не примет MHouse.

            Вид спрашивается у самой выгрузки, а состав незаполненного — у
            того же missingFields, которым пользуется фид MHouse.
            Повторять их списки здесь значило бы однажды написать «не
            попадает» о том, что уже попадает. */}
        <div className="row" style={{ marginTop: 8 }}>
          <span className="key">Выгрузка</span>
          {feedGaps.length === 0 ? (
            <span className="ok">объявление уйдёт на площадки</span>
          ) : (
            <span className="warn">не хватает: {feedGaps.join(', ')}</span>
          )}
        </div>
        {/* Что произошло с выгрузкой на самом деле. Строка выше говорит,
            ГОДИТСЯ ли объект; эта — УХОДИЛ ли он и забирала ли площадка
            файл. До этого кабинет не знал ни того ни другого, и ответить
            «наше объявление уже на house.kg?» можно было только сходив
            туда руками. */}
        {exported ? (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="key">MHouse</span>
            {exported.exportedAt && exported.status === 'exported' ? (
              <span>
                в выгрузке с{' '}
                {new Date(exported.exportedAt).toLocaleDateString('ru-RU')}
                {exported.lastPullAt
                  ? ` · площадка забирала фид ${when(exported.lastPullAt)}`
                  : ' · но фид площадка ещё ни разу не забирала'}
              </span>
            ) : exported.lastPullAt ? (
              <span className="tbl-note">
                в выгрузку не уходил; фид площадка забирала {when(exported.lastPullAt)}
              </span>
            ) : (
              <span className="tbl-note">
                фид площадка ещё ни разу не забирала — ссылку ей, возможно,
                не передавали
              </span>
            )}
          </div>
        ) : null}
        {exported?.exportedAt && exported.status === 'exported' ? (
          <p className="tbl-note" style={{ marginTop: 4 }}>
            Это значит «объект ушёл в файл и площадка файл забрала», а не
            «объявление опубликовано»: публикацию подтверждает только сама
            площадка, а она нам ничего не сообщает.
          </p>
        ) : null}
        {object.publication_state === 'published' && !inFeed(object.kind) ? (
          <p className="warn" style={{ marginTop: 8 }}>
            В выгрузку на Яндекс этот объект не попадает: формат для
            коммерческой недвижимости пока не определён. На MHouse и на
            сайте он показывается как обычно.
          </p>
        ) : null}
        <div className="row" style={{ marginTop: 8 }}>
          <span className="key">Мандат</span>
          {mandate ? (
            <>
              <span className="tag">{mandate.kind === 'exclusive' ? 'эксклюзив' : 'неэксклюзив'}</span>
              {!mandate.contract_confirmed ? (
                <span className="warn">договор требует подтверждения</span>
              ) : null}
              {mandate.valid_to ? (
                <>
                  <span className="key">до</span>
                  <span>{new Date(mandate.valid_to).toLocaleDateString('ru-RU')}</span>
                </>
              ) : null}
              {/* Комиссия и доля партнёра — условие, ради которого
                  коллега и открывает чужую карточку. Суммы индикативны:
                  считаются от текущей цены, а не от цены сделки. */}
              <span className="key">комиссия</span>
              <span>{money(mandate.commission_total, object.currency)}</span>
              <span className="key">партнёру</span>
              <span>
                {mandate.partner_rate !== null
                  ? `${String(mandate.partner_rate).replace('.', ',')}%`
                  : 'половина комиссии'}
                {mandate.partner_amount !== null
                  ? ` · ${money(mandate.partner_amount, object.currency)}`
                  : ''}
              </span>
            </>
          ) : (
            <span className="warn">активного мандата нет — объект нельзя опубликовать</span>
          )}
        </div>
        {/* Условия комиссии — свёрнутой формой под мандатом: их называют
            один раз и иногда уточняют, а ради уточнения незачем
            расторгать договор и заключать заново. */}
        {mandate && canEdit === true ? (
          <CommissionForm
            objectId={object.id}
            mandateId={mandate.id}
            dealType={object.deal_type as 'rent' | 'sale'}
            commissionPercent={mandate.commission_percent}
            partnerRate={mandate.partner_rate}
          />
        ) : null}
      </div>

      {/* Правка стоит ПЕРВОЙ и кнопкой, а не строчной ссылкой под рядом
          действий. Так было раньше, и владелец, глядя на свою же карточку,
          спросил, как отредактировать объявление: самое частое действие
          пряталось под тремя кнопками, две из которых снимают с публикации
          и расторгают договор. Снимать с публикации ради правки не нужно —
          изменения уходят в каталог сразу. */}
      {canEdit === true ? (
        <div className="actions" style={{ marginBottom: 4 }}>
          <Link className="btn" href={`/cabinet/objects/${object.id}/edit`}>
            Редактировать
          </Link>
        </div>
      ) : null}

      <ObjectActions
        objectId={object.id}
        publicationState={object.publication_state}
        activeMandateId={mandate?.id ?? null}
        canEdit={canEdit === true}
      />

      {canEdit === true ? (
        <>
          <div style={{ marginTop: 12 }}>
            <TransferForm
              action={transferObject}
              idField="object_id"
              idValue={object.id}
              colleagues={(colleagues ?? []) as Colleague[]}
              what="объект"
              warning="Объект и активный мандат перейдут коллеге — вместе с долей listing-агента в комиссии. Редактировать его вы больше не сможете."
            />
          </div>
        </>
      ) : null}


      {/* ПРОВЕРКА ПО ПЛОЩАДКАМ.
          Ради неё и собирался индекс рынка. «Проверен» — обещание, и
          проверяемо оно ровно здесь: объект, который уже висит на
          площадке под другой ценой или от другого продавца, виден
          агенту до того, как карточка уйдёт в работу.

          Утверждения «это тот же объект» тут нет и не будет: доказать
          его нечем, а ошибка обвиняет агента в перепосте чужого. Поэтому
          «похоже» и список совпавших признаков — решает человек. */}
      <div className="card">
        <h2>Проверка по площадкам</h2>

        {away !== null && priced?.valuation ? (
          <p>
            Цена{' '}
            {away === 0 ? <strong>в рынке</strong>
              : <strong>{away > 0 ? `на ${away}% выше рынка` : `на ${-away}% ниже рынка`}</strong>}
            {' '}— по {priced.valuation.basis.count} похожим объявлениям house.kg,
            середина {money(priced.valuation.midMinor / 100, object.currency)} —{' '}
            <Link className="crm-link" href={`/cabinet/assistant?deal=${object.deal_type}&kind=${object.kind}&city=${encodeURIComponent(object.city)}&rooms=${object.rooms ?? ''}&area=${object.area ?? ''}&cur=${object.currency}${object.zone ? `&zone=${encodeURIComponent(object.zone)}` : ''}`}>
              смотреть весь расчёт
            </Link>.
          </p>
        ) : priced && priced.valuation === null ? (
          <p className="tbl-note">
            Цену сравнить не с чем:{' '}
            {priced.reason === 'мало похожих'
              ? `похожих объявлений нашлось ${priced.pool}, а считать можно от пяти`
              : 'в индексе нет объявлений этого вида в этом городе'}.
          </p>
        ) : null}

        {lookalikes === null ? (
          <p className="tbl-note">Индекс рынка сейчас недоступен — проверка не выполнялась.</p>
        ) : !lookalikes.comparable ? (
          <p className="tbl-note">
            Объекты этого вида обход площадки не собирает — сравнивать не с чем.
          </p>
        ) : lookalikes.found.length === 0 ? (
          <p className="ok">Похожих объявлений на house.kg не нашлось.</p>
        ) : (
          <>
            {lookalikes.found.some((r) => r.ours) ? (
              <p className="ok">
                Это объявление на house.kg подано нами же. Расхождения ниже —
                наша собственная несогласованность: в кабинете одно, в нашем
                объявлении другое.
              </p>
            ) : null}
            {lookalikes.found.some((r) => !r.ours) ? (
              <p className="warn">
                Похоже, этот объект висит на house.kg и у кого-то ещё —{' '}
                {lookalikes.found.filter((r) => !r.ours).length === 1
                  ? 'одно объявление'
                  : `объявлений: ${lookalikes.found.filter((r) => !r.ours).length}`}.
                Это не доказательство: совпасть могут и две разные квартиры в
                одном доме. Смотрите признаки и решайте сами.
              </p>
            ) : null}
            {lookalikes.found.slice(0, 3).map((r) => (
              <div key={r.candidate.id} className="row" style={{ marginTop: 8, display: 'block' }}>
                <p>
                  {r.ours ? <span className="tag">наше</span> : null}{' '}
                  <Link className="crm-link-out" href={r.candidate.url} target="_blank"
                    rel="noopener noreferrer nofollow">
                    {r.candidate.address ?? 'объявление на house.kg'}
                  </Link>
                </p>
                <p className="tbl-note">Совпало: {r.signals.join(' · ')}</p>
                <p className="tbl-note">
                  Расходится:{' '}
                  {r.differences.map((d) => `${d.what} — у нас ${d.ours}, там ${d.theirs}`).join('; ')}
                </p>
              </div>
            ))}
          </>
        )}
      </div>

      <h2>Подборы ({rows.length})</h2>

      {rows.length === 0 ? (
        <p className="empty">По этому объекту подборов пока нет.</p>
      ) : (
        rows.map((m) => (
          <div className="card" key={m.match_id}>
            <div className="row">
              <MatchStatus
                matchId={m.match_id}
                status={m.match_status}
                showingAt={m.showing_at}
                rejectionReason={m.rejection_reason}
                canLead={m.can_lead}
                hasDeal={Boolean(m.deal_id)}
              />
              <ContactCell name={m.client_name} />
              <span className="key">бюджет</span>
              <span>
                {money(m.budget_min)} – {money(m.budget_max)}
              </span>
              {m.rooms_wanted?.length ? (
                <>
                  <span className="key">комнат</span>
                  <span>{m.rooms_wanted.join(', ')}</span>
                </>
              ) : null}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <span className="key">ведёт</span>
              <span>{m.closing_agent_name ?? '—'}</span>
              <span className="key">показ</span>
              <span>{when(m.showing_at)}</span>
              <span className="key">комиссия</span>
              <span>
                {money(m.commission_total)}
                {m.deal_status !== 'closed' ? ' (индикативно)' : ''}
              </span>
              {m.deal_id ? (
                <span className="tag">сделка: {m.deal_status}</span>
              ) : null}
            </div>
            {m.rejection_reason ? (
              <div className="row" style={{ marginTop: 6 }}>
                <span className="key">причина отказа</span>
                <span>{m.rejection_reason}</span>
              </div>
            ) : null}
            <div className="row" style={{ marginTop: 6 }}>
              <Link href={`/cabinet/requirements/${m.requirement_id}`}>к потребности →</Link>
              {m.deal_id ? (
                <Link href={`/cabinet/deals/${m.deal_id}`}>к сделке →</Link>
              ) : m.match_status !== 'rejected' ? (
                <StartDealButton
                  matchId={m.match_id}
                  objectId={object.id}
                  requirementId={m.requirement_id}
                />
              ) : null}
            </div>
          </div>
        ))
      )}

      <Activities
        entityType="object"
        entityId={object.id}
        rows={(activities ?? []) as ActivityRow[]}
        colleagues={(colleagues ?? []) as Colleague[]}
      />

      <h2>Создать подбор</h2>
      <CreateMatchForm
        fixed="object"
        fixedValue={object.id}
        options={options}
        back={`/cabinet/objects/${object.id}`}
        emptyHint="Нет открытых потребностей с подходящим типом сделки, под которые этот объект ещё не подобран."
      />
    </>
  );
}
