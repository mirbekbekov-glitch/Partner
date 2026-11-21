import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { allPhotos, daysSince, freshWord, KIND_RU, publicMoney, kindTitle } from '@/lib/catalog-params';
import { day } from '@/lib/list-params';
import { AGENCY_PHONES } from '@/lib/agency';
import { CatalogHeader } from '../../CatalogHeader';
import { CatalogFooter } from '../../CatalogFooter';
import { Facade } from '../../Facade';
import { Photo } from '../../Photo';
import { LeadForm } from '../../LeadForm';

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

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> },
): Promise<Metadata> {
  const { id } = await params;
  const o = await load(id);
  if (!o) return { title: 'Объект не найден' };
  const what = `${KIND_RU[o.kind] ?? o.kind}${o.rooms ? `, ${o.rooms} комн.` : ''}`;
  return {
    title: `${o.address} — ${publicMoney(o.price, o.currency)}`,
    description: `${o.deal_type === 'sale' ? 'Продажа' : 'Аренда'}: ${what}, ${o.address}.`,
  };
}

export default async function PublicObject({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
    ...(o.rooms ? [['Комнат', String(o.rooms)] as [string, string]] : []),
    ...(o.area ? [['Площадь', `${o.area} м²`] as [string, string]] : []),
    ...(o.floor ? [['Этаж', `${o.floor}${o.floors_total ? ` из ${o.floors_total}` : ''}`] as [string, string]] : []),
    ...(o.zone ? [['Район', o.zone] as [string, string]] : []),
    ['Опубликован', day(o.published_at)],
  ];

  return (
    <>
      <CatalogHeader />
      <div className="pub-wrap">
      <p className="key" style={{ marginTop: 16 }}><Link href="/">← Ко всем объектам</Link></p>

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
              {o.deal_type === 'sale' ? 'Продажа' : 'Аренда'} · {KIND_RU[o.kind] ?? o.kind}
              {o.zone ? ` · ${o.zone}` : ''}
            </p>
            <p className="pub-price-big">
              {publicMoney(o.price, o.currency)}
              {o.deal_type === 'rent' ? <span className="per"> / мес.</span> : null}
            </p>
          </div>

          <dl className="specs">
            {specs.map(([k, v]) => (
              <div className="spec" key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>

          {o.description ? (
            <div className="pub-desc">
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px' }}>Об объекте</h2>
              {o.description}
            </div>
          ) : null}

          <p className="fresh">Агент подтвердил цену и доступность {freshWord(days)}</p>
        </div>

        <div className="aside">
          <div className="panel-card">
            <h2>Посмотреть объект</h2>
            <p className="note">
              Заявка уходит агенту, который ведёт этот объект. Телефон видит только он.
            </p>
            <LeadForm objectId={o.id} address={o.address} />
          </div>
          <div className="callout">
            <b>Позвонить сейчас</b>
            Отдел продаж Liberterra.<br />
            {AGENCY_PHONES.map((p) => (
              <span key={p.href}><a href={p.href}>{p.display}</a><br /></span>
            ))}
          </div>
        </div>
      </div>
      </div>

      <CatalogFooter />
    </>
  );
}
