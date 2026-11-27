import type { Metadata } from 'next';
import { catalogCities, districts as loadDistricts } from '@/lib/db/catalog';
import { t, isLang, LANGS, type Lang, placeName } from '@/lib/i18n';
import { CatalogHeader } from '../../CatalogHeader';
import { CatalogFooter } from '../../CatalogFooter';
import { RequestForm, type RequestSide } from '../../RequestForm';

/**
 * С какой стороны открыта страница.
 *
 * Сторона живёт в адресе, а не только в состоянии формы: ссылкой на
 * «сдать или продать» делятся, и она должна открывать именно её. Чужое
 * значение не ошибка — просто обычная заявка на поиск.
 */
const sideOf = (v: unknown): RequestSide => (v === 'own' ? 'own' : 'find');

export const dynamic = 'force-dynamic';

export async function generateMetadata(
  { params, searchParams }: {
    params: Promise<{ lang: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  },
): Promise<Metadata> {
  const { lang } = await params;
  const d = t(isLang(lang) ? lang : 'ru');
  const own = sideOf((await searchParams).side) === 'own';
  // Заголовок вкладки — по стороне: «Что вы ищете?» на странице, открытой
  // собственником, отвечает не на тот вопрос, который он задал.
  const path = own ? `/request?side=own` : `/request`;
  return {
    title: own ? d.reqOwnTitle : d.reqTitle,
    description: own ? d.reqOwnLede : d.reqLede,
    alternates: {
      canonical: `/${lang}${path}`,
      languages: Object.fromEntries(LANGS.map((l) => [l, `/${l}${path}`])),
    },
  };
}

export default async function RequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: Lang }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { lang } = await params;
  const d = t(lang);
  const side = sideOf((await searchParams).side);
  const own = side === 'own';

  // Районы из справочника. Свободное поле на прежнем сайте дало 271
  // написание на 280 заявок — фильтровать по такому полю нельзя.
  // Справочник публичен по составу: те же названия стоят в адресах
  // объявлений.
  const districts = (await loadDistricts()).map((r) => r.name);

  // Город в шапке — тот же, что в подвале: по каталогу, а не руками.
  const place = placeName(await catalogCities(), d);

  return (
    <>
      <CatalogHeader lang={lang} />

      <section className="hero hero-slim">
        <div className="hero-in wrap">
          <span className="eyebrow">Liberterra · {place}</span>
          <h1>{own ? d.reqOwnTitle : d.reqTitle}</h1>
          <p className="lede">{own ? d.reqOwnLede : d.reqLede}</p>
          {/* Обещания разные: ищущему мы обещаем закрытый слой рынка,
              собственнику — что карточку и съёмку возьмёт на себя агент. */}
          <ul className="props">
            <li className="prop"><i className="mk" />{own ? d.reqOwnWhy1 : d.reqWhy1}</li>
            <li className="prop"><i className="mk" />{own ? d.reqOwnWhy2 : d.reqWhy2}</li>
            <li className="prop"><i className="mk" />{own ? d.reqOwnWhy3 : d.reqWhy3}</li>
          </ul>
        </div>
      </section>

      <div className="wrap">
        <div className="console reqconsole">
          <RequestForm lang={lang} districts={districts} side={side} />
        </div>
      </div>

      <CatalogFooter lang={lang} />
    </>
  );
}
