import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { allPhotos, KIND_RU } from '@/lib/catalog-params';
import { money, day } from '@/lib/list-params';
import { CatalogHeader } from '../../CatalogHeader';
import { Photo } from '../../Photo';

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
  // Тот же ключ anon и та же витрина, что и в списке: страница объекта не
  // должна знать о нём больше, чем каталог.
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
    title: `${o.address} — ${money(o.price, o.currency)}`,
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

  return (
    <>
      <CatalogHeader />
      <p className="key"><Link href="/">← ко всем объектам</Link></p>

      <h1>{o.address}</h1>
      <p className="sub">
        {o.deal_type === 'sale' ? 'Продажа' : 'Аренда'} · {KIND_RU[o.kind] ?? o.kind}
        {o.zone ? ` · ${o.zone}` : ''}
      </p>

      <p className="pub-price-big">{money(o.price, o.currency)}</p>

      {photos.length > 0 ? (
        <div className="pub-gallery">
          {photos.map((src) => (
            <Photo key={src} src={src} />
          ))}
        </div>
      ) : null}

      <div className="card">
        <div className="row">
          {o.rooms ? (<><span className="key">комнат</span><span>{o.rooms}</span></>) : null}
          {o.area ? (<><span className="key">площадь</span><span>{o.area} м²</span></>) : null}
          {o.floor ? (
            <>
              <span className="key">этаж</span>
              <span>{o.floor}{o.floors_total ? ` из ${o.floors_total}` : ''}</span>
            </>
          ) : null}
          {o.zone ? (<><span className="key">район</span><span>{o.zone}</span></>) : null}
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <span className="key">опубликован</span>
          <span>{day(o.published_at)}</span>
          {/* Дата актуальности важнее даты публикации: по ней видно, что
              объявление ведут, а не повесили и забыли. */}
          <span className="key">актуально на</span>
          <span>{day(o.actual_at)}</span>
        </div>
      </div>

      {o.description ? <p className="pub-desc">{o.description}</p> : null}
    </>
  );
}
