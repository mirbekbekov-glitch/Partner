import Link from 'next/link';
import { requireAgent } from '@/lib/db/session';
import { marketCities, marketUpdatedAt, ownerLeads, type OwnerFilter } from '@/lib/db/market';
import { invitation } from '@/lib/market/owners';
import { AGENCY_NAME } from '@/lib/agency';

export const metadata = { title: 'Собственники' };

/**
 * Поиск собственников: кому есть смысл звонить.
 *
 * Объявление от хозяина, которое висит давно и дешевеет, — это не «лид»,
 * а человек, который устал продавать сам. Остальные собственники в
 * выдаче подали вчера и полны надежд; звонок им сейчас только раздражает.
 *
 * ПРИЗНАКИ НАЗВАНЫ ВСЛУХ, у каждой строки списка. Это не украшение:
 * агент повторяет их в разговоре («вижу, объявление висит четыре
 * месяца»), и спрятанный балл в разговоре повторить нельзя.
 *
 * ТЕЛЕФОНА ЗДЕСЬ НЕТ. Площадка прячет его намеренно и открывает по
 * нажатию; собирать его в обход этого решения мы не станем. Агент
 * открывает объявление и нажимает «показать».
 */

const KINDS: Array<[OwnerFilter['kind'], string]> = [
  ['flat', 'квартиры'],
  ['room', 'комнаты'],
  ['house', 'дома'],
  ['land', 'участки'],
];

const money = (usd: number | null, kgs: number | null): string => {
  if (usd !== null) return `${usd.toLocaleString('ru-RU')} USD`;
  if (kgs !== null) return `${kgs.toLocaleString('ru-RU')} KGS`;
  return '—';
};

export default async function OwnersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireAgent();

  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);

  const cities = await marketCities();
  const updatedAt = await marketUpdatedAt();

  const deal = str('deal') === 'rent' ? 'rent' : 'sale';
  const kind = (KINDS.find(([k]) => k === str('kind'))?.[0] ?? 'flat') as OwnerFilter['kind'];
  const city = str('city') || cities[0] || 'Бишкек';
  const zone = str('zone')?.trim() || null;

  const leads = await ownerLeads({ deal, kind, city, zone });

  return (
    <>
      <h1>Собственники</h1>

      <p className="tbl-note">
        Объявления от хозяев, которые висят давно или дешевеют — то есть
        тех, кто устал продавать сам.{' '}
        {updatedAt
          ? `Индекс обновлялся ${new Date(updatedAt).toLocaleDateString('ru-RU')}.`
          : 'Индекс пока пуст: обход ещё не отрабатывал.'}
      </p>

      <form className="filters" method="get">
        <label className="fld">
          <span>Сделка</span>
          <select name="deal" defaultValue={deal}>
            <option value="sale">продажа</option>
            <option value="rent">аренда</option>
          </select>
        </label>
        <label className="fld">
          <span>Тип</span>
          <select name="kind" defaultValue={kind}>
            {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Город</span>
          <select name="city" defaultValue={city}>
            {(cities.length ? cities : ['Бишкек']).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="fld">
          <span>Район или ориентир</span>
          <input name="zone" type="search" defaultValue={zone ?? ''} />
        </label>
        <button type="submit">Показать</button>
      </form>

      {leads.length === 0 ? (
        <div className="card">
          <p><strong>Звонить пока некому.</strong></p>
          <p className="tbl-note">
            Это не поломка. Признак готовности — снижение цены или долгий
            срок, а узнаём мы их не сразу: снижение видно только со
            второго прогона обхода, дату публикации обход дочитывает по
            сорок объявлений за ночь. Через несколько дней список наберётся
            сам.
          </p>
        </div>
      ) : (
        <>
          <p className="tbl-note">Нашлось: {leads.length}. Сверху те, у кого признаков больше.</p>
          {leads.slice(0, 50).map((lead) => (
            <div className="card" key={lead.row.id}>
              <p>
                <strong>{money(lead.row.priceUsd, lead.row.priceKgs)}</strong>
                {lead.row.rooms ? ` · ${lead.row.rooms}-комн.` : ''}
                {lead.row.area ? ` · ${lead.row.area} м²` : ''}
                {lead.row.address ? ` · ${lead.row.address}` : ''}
              </p>

              <p className="tbl-note">
                {lead.signals.map((s) => s.text).join(' · ')}
                {lead.days !== null && lead.daysFrom === 'наш обход'
                  ? ' (срок считается с того дня, как объявление попалось нашему обходу — настоящий может быть больше)'
                  : ''}
              </p>

              <p>
                <Link className="crm-link-out" href={lead.row.url} target="_blank"
                  rel="noopener noreferrer nofollow">
                  Открыть объявление и посмотреть телефон
                </Link>
              </p>

              {/* Черновик, а не рассылка. Текст собран из фактов: письмо
                  незнакомому человеку от имени агентства, и выдуманная в
                  нём деталь стоит репутации. Агент читает, правит и
                  пишет сам. */}
              <details>
                <summary>Черновик первого сообщения</summary>
                <pre style={{ whiteSpace: 'pre-wrap' }}>
                  {invitation(lead, AGENCY_NAME, me.full_name)}
                </pre>
              </details>
            </div>
          ))}
        </>
      )}
    </>
  );
}
