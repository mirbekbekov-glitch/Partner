import Link from 'next/link';
import type { Metadata } from 'next';
import { catalogAgents } from '@/lib/db/catalog';
import { t, LANGS, isLang, type Lang } from '@/lib/i18n';
import { CatalogHeader } from '../../CatalogHeader';
import { CatalogFooter } from '../../CatalogFooter';
import { RequestPitch } from '../../RequestPitch';
import { AgentFace } from '../../AgentFace';

export const dynamic = 'force-dynamic';

export async function generateMetadata(
  { params }: { params: Promise<{ lang: string }> },
): Promise<Metadata> {
  const { lang: raw } = await params;
  const lang = isLang(raw) ? raw : 'ru';
  const d = t(lang);

  return {
    title: d.agentsTitle,
    description: d.agentsLede,
    alternates: {
      canonical: `/${lang}/agents`,
      languages: Object.fromEntries(LANGS.map((l) => [l, `/${l}/agents`])),
    },
  };
}

/**
 * Кто ведёт объекты — публичный список агентов.
 *
 * Здесь НЕТ звёзд, рейтинга и значков достижений, хотя у соседей по рынку
 * они есть. Отзывов система пока не собирает, критериев достижений не
 * существует, и нарисовать их значило бы выдумать то, по чему клиент
 * выбирает, с кем идти на сделку. То же правило, по которому в каталоге
 * нет метки «Топ».
 *
 * Показывается только то, что проверяемо: лицо, имя, подтверждённое
 * агентство, стаж от года начала, подтверждённый номер в реестре и число
 * объектов, которые человек действительно ведёт.
 */
export default async function AgentsPage({
  params,
}: {
  params: Promise<{ lang: Lang }>;
}) {
  const { lang } = await params;
  const d = t(lang);
  const agents = await catalogAgents();

  return (
    <>
      <CatalogHeader lang={lang} />
      <div className="wrap">
        <div className="dhead">
          <h1>{d.agentsTitle}</h1>
          <p className="sub">{d.agentsLede}</p>
        </div>

        {agents.length === 0 ? (
          <p className="empty">{d.agentsEmpty}</p>
        ) : (
          <div className="agent-grid">
            {agents.map((a) => (
              <Link key={a.id} href={`/${lang}/agents/${a.id}`} className="agent-tile">
                <AgentFace name={a.full_name} avatarKey={a.avatar_key} big />
                <b>{a.full_name}</b>
                {a.organization ? <span className="key">{a.organization}</span> : null}
                {a.works_since ? (
                  <span className="mini">
                    {d.agentYears(new Date().getFullYear() - a.works_since)}
                  </span>
                ) : null}
                <span className="num">{d.agentObjects(a.objects)}</span>
                {a.certificate_no ? (
                  <span className="tag">{d.agentRegistry(a.certificate_no)}</span>
                ) : null}
              </Link>
            ))}
          </div>
        )}
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
