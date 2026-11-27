import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { catalogAgentById, catalogPage } from '@/lib/db/catalog';
import { firstPhoto, publicMoney } from '@/lib/catalog-params';
import { thumbOf } from '@/lib/photo-url';
import { t, kindName, LANGS, isLang, type Lang } from '@/lib/i18n';
import { AGENCY_PHONES } from '@/lib/agency';
import { CatalogHeader } from '../../../CatalogHeader';
import { CatalogFooter } from '../../../CatalogFooter';
import { RequestPitch } from '../../../RequestPitch';
import { AgentFace } from '../../../AgentFace';
import { Facade } from '../../../Facade';
import { Photo } from '../../../Photo';
import { ContactRow } from '../../../ContactRow';

export const dynamic = 'force-dynamic';

/**
 * Страница агента.
 *
 * Пустой ответ витрины означает одно из трёх: агента нет, он не одобрен,
 * или у него нет ни одного опубликованного объекта. Во всех трёх случаях
 * страница отвечает 404, а не показывает пустую карточку: страница про
 * человека, которому нечего показать, работает против него же.
 */
async function load(id: string) {
  const agent = await catalogAgentById(id);
  if (!agent) return null;
  const objects = await catalogPage({ agent: id, pageSize: 60 });
  return { agent, objects };
}

export async function generateMetadata(
  { params }: { params: Promise<{ lang: string; id: string }> },
): Promise<Metadata> {
  const { lang: raw, id } = await params;
  const lang = isLang(raw) ? raw : 'ru';
  const d = t(lang);
  const found = await load(id);
  if (!found) return { title: d.agentNotFound };

  return {
    title: found.agent.full_name,
    description: `${found.agent.full_name} — ${d.agentObjects(found.agent.objects)}.`,
    alternates: {
      canonical: `/${lang}/agents/${id}`,
      languages: Object.fromEntries(LANGS.map((l) => [l, `/${l}/agents/${id}`])),
    },
  };
}

export default async function AgentPage({
  params,
}: {
  params: Promise<{ lang: Lang; id: string }>;
}) {
  const { lang, id } = await params;
  const d = t(lang);
  const found = await load(id);
  if (!found) notFound();

  const { agent, objects } = found;
  const years = agent.works_since ? new Date().getFullYear() - agent.works_since : null;

  return (
    <>
      <CatalogHeader lang={lang} />
      <div className="wrap">
        <Link className="back" href={`/${lang}/agents`}>{d.toAgents}</Link>

        <div className="agent-head">
          <AgentFace name={agent.full_name} avatarKey={agent.avatar_key} big />
          <div>
            <h1>{agent.full_name}</h1>
            {agent.organization ? <p className="sub">{agent.organization}</p> : null}
            <p className="facts">
              {years !== null && years >= 0 ? (
                <span className="fact">{d.agentYears(years)}</span>
              ) : null}
              <span className="fact num">{d.agentObjects(agent.objects)}</span>
            </p>
            {agent.certificate_no ? (
              <p className="registry">
                {d.agentRegistry(agent.certificate_no)}
                <span className="key">{d.agentRegistryNote}</span>
              </p>
            ) : null}
            {/* Связь с агентом — на том же месте, что и на карточке
                объекта. Телефон агентства ниже остаётся запасным
                путём: агент бывает в показе и не берёт трубку. */}
            <ContactRow lang={lang} contact={agent} />
            <div className="callout" style={{ marginTop: 16 }}>
              <b>{d.callNow}</b>
              <span className="mini">{d.salesDept}</span>
              {AGENCY_PHONES.map((p) => (
                <a key={p.href} href={p.href} className="mono">{p.display}</a>
              ))}
            </div>
          </div>
        </div>

        <h2>{d.agentOf}</h2>
        <div className="grid">
          {objects.items.map((o) => {
            const photo = firstPhoto(o.photos);
            const facade = <Facade o={o} variant={0} alt={d.drawingAlt} />;

            return (
              <Link key={o.id} href={`/${lang}/objects/${o.id}`} className="card-obj">
                <div className="pic">
                  {photo ? <Photo src={thumbOf(photo)} fallback={facade} /> : facade}
                </div>
                <div className="card-body">
                  <p className="price num">{publicMoney(lang, o.price, o.currency)}</p>
                  <p className="addr">{o.address}</p>
                  <p className="facts">
                    <span className="fact">{kindName(lang, o.kind)}</span>
                    {o.zone ? <span className="fact">{o.zone}</span> : null}
                  </p>
                </div>
              </Link>
            );
          })}
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
