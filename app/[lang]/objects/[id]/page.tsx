import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { allPhotos, daysSince, publicMoney } from '@/lib/catalog-params';
import { t, kindName, freshWordIn, LOCALE, LANGS, isLang, type Lang } from '@/lib/i18n';
import { AGENCY_PHONES } from '@/lib/agency';
import { CatalogHeader } from '../../../CatalogHeader';
import { CatalogFooter } from '../../../CatalogFooter';
import { Facade } from '../../../Facade';
import { Photo } from '../../../Photo';
import { LeadForm } from '../../../LeadForm';

export const dynamic = 'force-dynamic';

type Row = {
  id: string;
  kind: string;
  deal_type: 'rent' | 'sale';
  address: string;
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

async function load(id: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from('public_catalog_v')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  return (data as Row | null) ?? null;
}

/** Дата по правилам языка: 14.03.2026, 14/03/2026, 2026/3/14. */
const dateIn = (lang: Lang, iso: string) =>
  new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: 'medium' }).format(new Date(iso));

export async function generateMetadata(
  { params }: { params: Promise<{ lang: string; id: string }> },
): Promise<Metadata> {
  const { lang: raw, id } = await params;
  const lang = isLang(raw) ? raw : 'ru';
  const d = t(lang);
  const o = await load(id);
  if (!o) return { title: d.notFound };
  const what = `${kindName(lang, o.kind)}${o.rooms ? `, ${o.rooms} ${d.roomsShort}` : ''}`;
  return {
    title: `${o.address} — ${publicMoney(lang, o.price, o.currency)}`,
    description: `${o.deal_type === 'sale' ? d.sale : d.rent}: ${what}, ${o.address}.`,
    alternates: {
      canonical: `/${lang}/objects/${id}`,
      languages: Object.fromEntries(LANGS.map((l) => [l, `/${l}/objects/${id}`])),
    },
  };
}

export default async function PublicObject({
  params,
}: {
  params: Promise<{ lang: Lang; id: string }>;
}) {
  const { lang, id } = await params;
  const d = t(lang);
  const o = await load(id);

  // Снятый с публикации объект исчезает из витрины, и страница честно
  // становится 404 — вместо того чтобы показывать устаревшую цену.
  if (!o) notFound();

  const photos = allPhotos(o.photos);
  const days = daysSince(o.actual_at);
  // В галерее три места. Фотографий может не быть вовсе или быть одна —
  // остальные занимает рисунок, чтобы сетка не разъезжалась.
  const slots = [0, 1, 2].map((i) => ({
    photo: photos[i] ?? null,
    facade: <Facade o={o} variant={i} />,
  }));

  const specs: [string, string][] = [
    ...(o.rooms ? [[d.roomsLabel, String(o.rooms)] as [string, string]] : []),
    ...(o.area ? [[d.areaLabel, `${o.area} ${d.sqm}`] as [string, string]] : []),
    ...(o.floor ? [[d.floorLabel, `${o.floor}${o.floors_total ? ` ${d.floorOf} ${o.floors_total}` : ''}`] as [string, string]] : []),
    ...(o.zone ? [[d.zoneLabel, o.zone] as [string, string]] : []),
    [d.published, dateIn(lang, o.published_at)],
  ];

  return (
    <>
      <CatalogHeader lang={lang} />
      <div className="pub-wrap">
      <p className="key" style={{ marginTop: 16 }}><Link href={`/${lang}`}>{d.toAll}</Link></p>

      <div className="pub-detail">
        <div>
          <div className="gal">
            <div className="shot">
              {slots[0].photo ? <Photo src={slots[0].photo} fallback={slots[0].facade} /> : slots[0].facade}
            </div>
            <div className="side">
              {slots.slice(1).map((s, i) => (
                <div className="shot" key={i}>
                  {s.photo ? <Photo src={s.photo} fallback={s.facade} /> : s.facade}
                </div>
              ))}
            </div>
          </div>

          <div className="pub-dhead">
            <h1>{o.address}</h1>
            <p className="sub">
              {o.deal_type === 'sale' ? d.sale : d.rent} · {kindName(lang, o.kind)}
              {o.zone ? ` · ${o.zone}` : ''}
            </p>
            <p className="pub-price-big">
              {publicMoney(lang, o.price, o.currency)}
              {o.deal_type === 'rent' ? <span className="per">{d.perMonth}</span> : null}
            </p>
          </div>

          <dl className="specs">
            {specs.map(([k, v]) => (
              <div className="spec" key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>

          {/* Описание и адрес остаются на языке агента: машинный перевод
              характеристик жилья врёт слишком дорого. */}
          {o.description ? (
            <div className="pub-desc">
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px' }}>{d.about}</h2>
              {o.description}
            </div>
          ) : null}

          <p className="fresh">{d.confirmedPrice} · {freshWordIn(lang, days)}</p>
        </div>

        <div className="aside">
          <div className="panel-card">
            <h2>{d.viewObject}</h2>
            <p className="note">{d.leadNote}</p>
            <LeadForm lang={lang} objectId={o.id} address={o.address} />
          </div>
          <div className="callout">
            <b>{d.callNow}</b>
            {d.salesDept}<br />
            {AGENCY_PHONES.map((p) => (
              <span key={p.href}><a href={p.href}>{p.display}</a><br /></span>
            ))}
          </div>
        </div>
      </div>
      </div>

      <CatalogFooter lang={lang} />
    </>
  );
}
