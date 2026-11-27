import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { catalogObject, catalogAgent, catalogRate } from '@/lib/db/catalog';
import {
  allPhotos, firstPhoto, daysSince, publicMoney, priceView, parseCatalogFilters,
} from '@/lib/catalog-params';
import type { Money } from '@/lib/fx';
import { t, spaceName, freshWordIn, LOCALE, LANGS, isLang, type Lang } from '@/lib/i18n';
import { AGENCY_PHONES } from '@/lib/agency';
import { siteUrl } from '@/lib/site';
import { listingSchema } from '@/lib/listing-schema';
import { CatalogHeader } from '../../../CatalogHeader';
import { CatalogFooter } from '../../../CatalogFooter';
import { RequestPitch } from '../../../RequestPitch';
import { Facade } from '../../../Facade';
import { Photo } from '../../../Photo';
import { AgentFace } from '../../../AgentFace';
import { LeadForm } from '../../../LeadForm';
import { ContactRow } from '../../../ContactRow';
import { Tour360 } from '../../../Tour360';

export const dynamic = 'force-dynamic';

type Row = {
  id: string;
  kind: string;
  deal_type: 'rent' | 'sale';
  address: string;
  city: string;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floors_total: number | null;
  price: number;
  currency: string;
  photos: unknown;
  description: string | null;
  published_at: string;
  actual_at: string;
};

/**
 * Карточка объекта из витрины.
 *
 * Черновик и снятый объект отдают НИЧЕГО, и страница отвечает 404. Это не
 * вежливость: иначе по прямой ссылке видна устаревшая цена, а существование
 * черновика выясняется перебором идентификаторов.
 */
async function load(id: string) {
  try {
    return await catalogObject(id);
  } catch {
    // База недоступна — это не «объекта нет». Пусть страница ответит
    // ошибкой, а не выдумает 404 о существующем объекте.
    throw new Error('Каталог недоступен');
  }
}

/** Дата по правилам языка: 18.11.2026, 11/18/2026, 2026/11/18.
 *  Короткая форма, а не «18 нояб. 2026 г.»: длинная не помещалась в
 *  колонку характеристик и ломалась на две строки. */
const dateIn = (lang: Lang, iso: string) =>
  new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: 'short' }).format(new Date(iso));

export async function generateMetadata(
  { params }: { params: Promise<{ lang: string; id: string }> },
): Promise<Metadata> {
  const { lang: raw, id } = await params;
  const lang = isLang(raw) ? raw : 'ru';
  const d = t(lang);
  const o = await load(id);
  if (!o) return { title: d.notFound };
  const what = `${spaceName(lang, o)}${o.rooms ? `, ${o.rooms} ${d.roomsShort}` : ''}`;
  const title = `${o.address} — ${publicMoney(lang, o.price, o.currency)}`;
  const description = `${o.deal_type === 'sale' ? d.sale : d.rent}: ${what}, ${o.address}.`;
  const photo = firstPhoto(o.photos);

  return {
    title,
    description,
    alternates: {
      canonical: `/${lang}/objects/${id}`,
      languages: Object.fromEntries(LANGS.map((l) => [l, `/${l}/objects/${id}`])),
    },
    // Превью при пересылке: фотография самого объекта говорит получателю
    // больше любой нарисованной карточки. Если фотографии нет, ключ
    // images не задаём — тогда подхватится общая карточка каталога из
    // app/opengraph-image.tsx, а не пустое место.
    openGraph: {
      type: 'website',
      url: `/${lang}/objects/${id}`,
      title,
      description,
      ...(photo ? { images: [{ url: photo, alt: o.address }] } : {}),
    },
  };
}

export default async function PublicObject({
  params,
  searchParams,
}: {
  params: Promise<{ lang: Lang; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { lang, id } = await params;
  // Валюта приходит тем же параметром, что и в каталоге: человек выбрал
  // её там, перешёл сюда — и видит ту же.
  const chosen = parseCatalogFilters(await searchParams).money;
  const fx = await catalogRate().catch(() => null);
  const rate = fx?.som_per_unit ?? null;
  const money: Money | null = rate ? (chosen ?? 'USD') : null;
  const d = t(lang);
  const o = await load(id);

  // Снятый с публикации объект исчезает из витрины, и страница честно
  // становится 404 — вместо того чтобы показывать устаревшую цену.
  if (!o) notFound();

  // Кто ведёт объект. Витрина отдаёт ровно три поля — имя, год начала
  // работы и номер в реестре, и только подтверждённый администратором.
  // Телефона и почты агента здесь нет: звонок идёт в отдел продаж.
  // Запрос необязательный: если агента не нашли, страница просто обходится
  // без блока, а не ломается.
  const agent = await catalogAgent(o.id).catch(() => null);
  const years = agent?.works_since ? new Date().getFullYear() - agent.works_since : null;

  const photos = allPhotos(o.photos);
  const days = daysSince(o.actual_at);
  // В галерее три места. Фотографий может не быть вовсе или быть одна —
  // остальные занимает рисунок, чтобы сетка не разъезжалась.
  const slots = [0, 1, 2].map((i) => ({
    photo: photos[i] ?? null,
    facade: <Facade o={o} variant={i} alt={d.drawingAlt} />,
  }));

  const specs: [string, string][] = [
    ...(o.rooms ? [[d.roomsLabel, String(o.rooms)] as [string, string]] : []),
    ...(o.area ? [[d.areaLabel, `${o.area} ${d.sqm}`] as [string, string]] : []),
    ...(o.floor ? [[d.floorLabel, `${o.floor}${o.floors_total ? ` ${d.floorOf} ${o.floors_total}` : ''}`] as [string, string]] : []),
    // Город здесь показывается ВСЕГДА, в отличие от карточки в списке.
    // Страница про один объект, и повторения не возникает; зато человек,
    // пришедший по ссылке из переписки или с площадки, видит город сразу,
    // а не угадывает его по названию улицы.
    [d.cityLabel, o.city],
    ...(o.zone ? [[d.zoneLabel, o.zone] as [string, string]] : []),
    // Дата публикации в базе необязательна. Если её нет, показывается дата
    // актуальности: она есть всегда, и это ближайшее по смыслу.
    [d.published, dateIn(lang, o.published_at ?? o.actual_at)],
  ];

  // Разметка для поисковика. «<» внутри описания закрыл бы <script>
  // раньше времени и оставил бы остаток JSON в вёрстке, поэтому экранируем
  // его — это обязательная мера для любого JSON внутри тега, а не
  // перестраховка.
  const schema = JSON.stringify(
    listingSchema(o, lang, `${o.address} — ${publicMoney(lang, o.price, o.currency)}`),
  ).replace(/</g, '\\u003c');

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: schema }} />
      <CatalogHeader lang={lang} money={money} />
      <div className="wrap">
        <Link className="back" href={`/${lang}`}>{d.toAll}</Link>

        <div className="detail">
          <div>
            <div className="gal">
              <div className="pic">
                {slots[0].photo ? <Photo src={slots[0].photo} fallback={slots[0].facade} /> : slots[0].facade}
              </div>
              <div className="side">
                {slots.slice(1).map((s, i) => (
                  <div className="pic" key={i}>
                    {s.photo ? <Photo src={s.photo} fallback={s.facade} /> : s.facade}
                  </div>
                ))}
              </div>
            </div>

            <div className="dhead">
              <h1>{o.address}</h1>
              <p className="sub">
                {o.deal_type === 'sale' ? d.sale : d.rent} · {spaceName(lang, o)}
                {o.zone ? ` · ${o.zone}` : ''}
              </p>
              {/* В заголовке вкладки и в разметке для поисковика цена
                  остаётся ИСХОДНОЙ — см. generateMetadata. Пересчёт живёт
                  только здесь, на экране, и только с пометкой. */}
              <p className="price-big num">
                {priceView(lang, o.price, o.currency, money, rate).main}
                {o.deal_type === 'rent' ? <small>{d.perMonth}</small> : null}
              </p>
              {priceView(lang, o.price, o.currency, money, rate).note ? (
                <p className="price-orig">
                  {priceView(lang, o.price, o.currency, money, rate).note}
                  {' '}{d.priceFromAd}
                  {fx ? <span className="key">{d.rateNote(fx.as_of)}</span> : null}
                </p>
              ) : null}
            </div>

            {/* Честная подпись под снимками: с кадров стёрли предметы.
                Свет и баланс белого квартиру не меняют и пометки не
                требуют — иначе ярлык висел бы на каждом объявлении и
                перестал бы читаться. */}
            {o.retouched ? <p className="retouch">{d.retouched}</p> : null}

            {/* Тур стоит ПОСЛЕ снимков и до характеристик: снимки
                решают, смотреть ли дальше, а тур — то, ради чего
                остаются на странице. Нет панорам — нет и блока. */}
            {o.panoramas.length > 0 ? (
              <Tour360
                title={d.tourTitle}
                rooms={o.panoramas.map((p) => ({
                  key: p.key, url: p.url, room: p.room, w: p.w, h: p.h,
                  links: p.links ?? [],
                }))}
              />
            ) : null}

            <dl className="specs">
              {specs.map(([k, v]) => (
                <div className="spec" key={k}><dt>{k}</dt><dd className="num">{v}</dd></div>
              ))}
            </dl>

            {/* Описание и адрес остаются на языке агента: машинный перевод
                характеристик жилья врёт слишком дорого. */}
            {o.description ? (
              <div className="desc">
                <h2>{d.about}</h2>
                {o.description}
              </div>
            ) : null}

            <p className="fresh"><i className="pulse" />{d.confirmedPrice} · {freshWordIn(lang, days)}</p>
          </div>

          <div className="aside">
            <div className="panel-card">
              <h2>{d.viewObject}</h2>
              <p className="note">{d.leadNote}</p>
              <LeadForm lang={lang} objectId={o.id} address={o.address} />
            </div>
            {agent ? (
              <div className="agent-card">
                <span className="key">{d.agentLeads}</span>
                {/* Ссылка на страницу агента: клиент хочет знать, с кем
                    имеет дело, и список его объектов отвечает на это
                    лучше любого описания. */}
                <Link className="agent-row" href={`/${lang}/agents/${agent.id}`}>
                  <AgentFace name={agent.full_name} avatarKey={agent.avatar_key} />
                  <div>
                    <b>{agent.full_name}</b>
                    {years !== null && years >= 0 ? (
                      <span className="mini">{d.agentYears(years)}</span>
                    ) : null}
                  </div>
                </Link>
                {/* Связь с тем, кто ведёт объект: номер и мессенджеры.
                    Раньше здесь не было ничего, а звонок шёл в отдел
                    продаж — решение владельца площадки изменилось в
                    пользу скорости ответа. */}
                {/* Текст готовится ЗДЕСЬ, а не в компоненте связи: только
                    страница объекта знает, о каком объекте речь. Цена — из
                    объявления, в валюте собственника, а не пересчитанная:
                    клиент цитирует то, что увидел, и пересчёт в его
                    сообщении выглядел бы торгом ещё до разговора. */}
                <ContactRow
                  lang={lang}
                  contact={agent}
                  message={d.waText(
                    o.address,
                    publicMoney(lang, o.price, o.currency),
                    siteUrl(`/${lang}/objects/${o.id}`),
                  )}
                />
                {agent.certificate_no ? (
                  <p className="registry">
                    {d.agentRegistry(agent.certificate_no)}
                    <span className="key">{d.agentRegistryNote}</span>
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="callout">
              <b>{d.callNow}</b>
              <span className="mini">{d.salesDept}</span>
              {AGENCY_PHONES.map((p) => (
                <a key={p.href} href={p.href} className="mono">{p.display}</a>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Вход в форму заявки. Раньше он был в шапке кнопкой; теперь на
          главной подпись «Оставить заявку» стоит над развилкой первого
          экрана, а на внутренних страницах формой заканчивается
          страница — там же, где человек понимает, что нужного не нашёл. */}
      <RequestPitch lang={lang} />
      <CatalogFooter lang={lang} />
    </>
  );
}
