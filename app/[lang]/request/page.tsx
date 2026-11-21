import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { t, isLang, LANGS, type Lang } from '@/lib/i18n';
import { CatalogHeader } from '../../CatalogHeader';
import { CatalogFooter } from '../../CatalogFooter';
import { RequestForm } from '../../RequestForm';

export const dynamic = 'force-dynamic';

export async function generateMetadata(
  { params }: { params: Promise<{ lang: string }> },
): Promise<Metadata> {
  const { lang } = await params;
  const d = t(isLang(lang) ? lang : 'ru');
  return {
    title: d.reqTitle,
    description: d.reqLede,
    alternates: {
      canonical: `/${lang}/request`,
      languages: Object.fromEntries(LANGS.map((l) => [l, `/${l}/request`])),
    },
  };
}

export default async function RequestPage({
  params,
}: {
  params: Promise<{ lang: Lang }>;
}) {
  const { lang } = await params;
  const d = t(lang);

  // Районы из справочника. Свободное поле на прежнем сайте дало 271
  // написание на 280 заявок — фильтровать по такому полю нельзя.
  const supabase = await createClient();
  const { data } = await supabase
    .from('districts')
    .select('name')
    .eq('active', true)
    .order('sort');
  const districts = (data ?? []).map((r) => r.name as string);

  return (
    <>
      <CatalogHeader lang={lang} />

      <section className="hero hero-slim">
        <div className="hero-in wrap">
          <span className="eyebrow">Liberterra · {d.city}</span>
          <h1>{d.reqTitle}</h1>
          <p className="lede">{d.reqLede}</p>
          <ul className="props">
            <li className="prop"><i className="mk" />{d.reqWhy1}</li>
            <li className="prop"><i className="mk" />{d.reqWhy2}</li>
            <li className="prop"><i className="mk" />{d.reqWhy3}</li>
          </ul>
        </div>
      </section>

      <div className="wrap">
        <div className="console reqconsole">
          <RequestForm lang={lang} districts={districts} />
        </div>
      </div>

      <CatalogFooter lang={lang} />
    </>
  );
}
