import Link from 'next/link';
import { requireAgent } from '@/lib/db/session';
import { estimate, marketCities, marketUpdatedAt, type ValueSpec } from '@/lib/db/market';
import { awayFromMarket } from '@/lib/market/valuation';
import { formatMinor } from '@/lib/db/money';

export const metadata = { title: 'Оценка' };

/**
 * Оценка объекта по сопоставимым.
 *
 * ЧТО ЗДЕСЬ ГЛАВНОЕ. Не число, а то, на чём оно построено. Агент идёт с
 * этой страницы к собственнику, и там ему скажут «а почему так мало?» —
 * ответом должен быть список похожих объявлений, а не «система
 * посчитала». Поэтому вилка и аналоги показываются вместе, всегда, и
 * список нельзя свернуть.
 *
 * Условия живут в строке запроса, как у каталога: расчётом можно
 * поделиться ссылкой, и он воспроизводится — а не существует только на
 * экране того, кто нажал.
 *
 * ОТКАЗ — ТОЖЕ ОТВЕТ. «Мало похожих» печатается словами, с числом
 * найденных. Выдать вилку по трём объявлениям было бы хуже, чем не
 * выдать ничего: по ней пошли бы разговаривать с собственником.
 */

const KINDS: Array<[ValueSpec['kind'], string]> = [
  ['flat', 'квартира'],
  ['room', 'комната'],
  ['house', 'дом'],
  ['land', 'участок'],
];

const WIDENING_NOTE: Record<string, string> = {
  'точно': 'тот же район, та же комнатность, близкая площадь',
  'без района': 'район пришлось снять — в нём похожих не набралось',
  'комнаты ±1': 'комнатность расширена на соседнюю',
  'без комнат': 'комнатность снята — считано по площади',
  'широко': 'взят весь город: по точным условиям похожих нет',
};

function num(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Площадь по-русски: запятая, а не точка. «54.84» глаз спотыкается. */
function m2(value: number): string {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

/** «Поднято 4 дня назад» — факт с карточки, без выдуманной оценки свежести. */
function ago(at: string | null): string {
  if (!at) return 'срок не указан';
  const days = Math.floor((Date.now() - Date.parse(at)) / (24 * 3600_000));
  if (!Number.isFinite(days)) return 'срок не указан';
  if (days <= 0) return 'поднято сегодня';
  if (days === 1) return 'поднято вчера';
  return `поднято ${days} дн. назад`;
}

const SELLER_RU: Record<string, string> = {
  owner: 'собственник',
  agency: 'агентство',
  unknown: 'продавец не определён',
};

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAgent();

  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);

  const cities = await marketCities();
  const updatedAt = await marketUpdatedAt();

  const deal = str('deal') === 'rent' ? 'rent' : 'sale';
  const kind = (KINDS.find(([k]) => k === str('kind'))?.[0] ?? 'flat') as ValueSpec['kind'];
  const city = str('city') || cities[0] || 'Бишкек';
  const zone = str('zone')?.trim() || null;
  const rooms = num(str('rooms'));
  const area = num(str('area'));
  const currency = str('cur') === 'KGS' ? 'KGS' : 'USD';
  const period = deal === 'rent' ? (str('period') === 'day' ? 'day' : 'month') : null;

  const result = area === null ? null : await estimate({
    deal, kind, city, zone, rooms, area, currency, period,
  });

  return (
    <>
      <h1>Оценка по сопоставимым</h1>

      <p className="tbl-note">
        Считается по объявлениям house.kg, собранным в наш индекс.{' '}
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
        <label className="fld">
          <span>Комнат</span>
          <input name="rooms" type="number" min="1" max="20" defaultValue={rooms ?? ''} />
        </label>
        <label className="fld">
          <span>Площадь, м²</span>
          <input name="area" type="number" min="1" step="0.1" defaultValue={area ?? ''} />
        </label>
        <label className="fld">
          <span>Валюта</span>
          <select name="cur" defaultValue={currency}>
            <option value="USD">доллары</option>
            <option value="KGS">сомы</option>
          </select>
        </label>
        {deal === 'rent' ? (
          <label className="fld">
            <span>Срок</span>
            <select name="period" defaultValue={period ?? 'month'}>
              <option value="month">в месяц</option>
              <option value="day">в сутки</option>
            </select>
          </label>
        ) : null}
        <button type="submit">Оценить</button>
      </form>

      {area === null ? (
        <p className="tbl-note">
          Площадь обязательна: цена считается за метр, а потом умножается на
          площадь. Без неё считать нечего.
        </p>
      ) : null}

      {result && result.valuation === null ? (
        <div className="card">
          <p>
            <strong>Оценки нет.</strong>{' '}
            {result.reason === 'индекс пуст'
              ? 'В индексе нет объявлений этого типа в этом городе за последние полгода.'
              : result.reason === 'нет площади'
                ? 'Не указана площадь.'
                : `Похожих объявлений нашлось ${result.pool}, а считать можно от пяти.`}
          </p>
          <p className="tbl-note">
            Это отказ, а не ошибка. Вилка по двум-трём объявлениям — число,
            которое нельзя показать собственнику: на нём не на что опереться.
          </p>
        </div>
      ) : null}

      {result?.valuation ? (
        <>
          <div className="card">
            <p className="board-money">
              {formatMinor(result.valuation.lowMinor, currency)} —{' '}
              {formatMinor(result.valuation.highMinor, currency)}
            </p>
            <p>
              Середина рынка — <strong>{formatMinor(result.valuation.midMinor, currency)}</strong>,
              это {formatMinor(result.valuation.perMetreMinor, currency)} за м².
            </p>
            <p className="tbl-note">
              Вилка — не «плюс-минус сколько-то процентов»: внутри неё лежит
              ровно половина похожих объявлений, от четверти самых дешёвых до
              четверти самых дорогих.
            </p>
            <p className="tbl-note">
              Построено на {result.valuation.basis.count} объявлениях:{' '}
              {WIDENING_NOTE[result.valuation.basis.widening]}. Площадь в
              выборке от {result.valuation.basis.areaFrom} до{' '}
              {result.valuation.basis.areaTo} м².
              {result.rate && currency === 'USD'
                ? ` Цены в сомах приведены по ${Math.round(result.rate)} сом за доллар — курс посчитан по самим объявлениям.`
                : null}
            </p>
          </div>

          <h2>Объявления, на которых построен вывод</h2>
          <table className="tbl">
            <thead>
              <tr>
                <th>Цена</th>
                <th>За м²</th>
                <th>К рынку</th>
                <th>Площадь</th>
                <th>Адрес</th>
                <th>Продавец</th>
                <th>Свежесть</th>
                <th>Источник</th>
              </tr>
            </thead>
            <tbody>
              {result.valuation.used
                .slice()
                .sort((a, b) => a.priceMinor / a.area - b.priceMinor / b.area)
                .map((c) => {
                  // Сравнение идёт ценой за метр с ценой за метр: так оно
                  // не зависит от площади оцениваемого объекта и остаётся
                  // верным, даже если тот сильно крупнее аналогов.
                  const away = awayFromMarket(
                    Math.round(c.priceMinor / c.area),
                    { ...result.valuation!, midMinor: result.valuation!.perMetreMinor },
                  );
                  return (
                    <tr key={c.id}>
                      <td>{formatMinor(c.priceMinor, currency)}</td>
                      {/* До целой единицы: цена за метр с копейками обещает
                          точность, которой нет ни у одного объявления. */}
                      <td>
                        {formatMinor(
                          Math.round(c.priceMinor / c.area / 100) * 100, currency,
                        )}
                      </td>
                      <td>{away === 0 ? 'в рынке' : away > 0 ? `+${away}%` : `${away}%`}</td>
                      <td>{m2(c.area)} м²{c.rooms ? `, ${c.rooms}-комн.` : ''}</td>
                      <td>{c.address ?? '—'}</td>
                      <td>{SELLER_RU[c.sellerKind]}</td>
                      <td>{ago(c.bumpedAt)}</td>
                      <td>
                        <Link className="crm-link-out" href={c.url} target="_blank"
                          rel="noopener noreferrer nofollow">
                          house.kg
                        </Link>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </>
      ) : null}
    </>
  );
}
