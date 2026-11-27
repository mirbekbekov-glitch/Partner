import 'server-only';
import {
  SECTIONS, TOWNS, bumpedAt, fetchSearchPage, parseListingPage, parseSearchPage,
  searchUrl, type MarketCard,
} from './house-kg';
import {
  markGone, marketSize, ownersWithoutDate, saveCards, setListingPage,
  type SectionReport,
} from '@/lib/db/market';
import { now } from '@/lib/db/sql';

/**
 * Ночной обход house.kg: наполнение индекса рынка.
 *
 * ПОЧЕМУ ПО РАСПИСАНИЮ, А НЕ В МОМЕНТ ВОПРОСА. Оценка, которая ходит на
 * чужой сайт прямо при нажатии кнопки, зависит от его доступности и
 * упирается в его терпение: десять агентов — десять обходов. Раз в сутки
 * мы читаем рынок один раз для всех, а оценка считается по своей базе и
 * отвечает мгновенно. Это тот же приём, которым уже живёт перенос
 * каталога старого сайта.
 *
 * СКОЛЬКО БЕРЁМ. По пять страниц на раздел — это до двухсот свежайших
 * объявлений в каждом. Выдача площадки отсортирована по свежести, то есть
 * пять страниц покрывают всё, что появилось и поднялось за сутки, а
 * остальное у нас уже есть с прошлых прогонов. Брать всё целиком каждую
 * ночь значило бы тысячи запросов ради тех же строк.
 *
 * ПАУЗА МЕЖДУ СТРАНИЦАМИ обязательна. Сорок быстрых запросов подряд с
 * одного адреса — это поведение, от которого площадки и закрываются. Нам
 * спешить некуда: прогон ночной, и секунда на страницу ничего не стоит.
 */

/**
 * Сколько страниц объявлений читаем за прогон ради даты публикации.
 *
 * Дата нужна только поиску собственников и берётся не из выдачи, а со
 * страницы самого объявления: в выдаче написано, когда объявление
 * ПОДНЯЛИ, а не когда подали. Разница решающая — поднятое сегодня может
 * висеть с весны.
 *
 * Сорок за ночь, а не все сразу: это сорок лишних запросов к чужому
 * сайту вдобавок к обходу выдачи. Очередь разбирается за несколько
 * ночей, и спешить некуда — дата публикации не протухает.
 */
const LISTINGS_PER_RUN = 40;

/** Сколько страниц читаем в разделе за прогон. */
const PAGES_PER_SECTION = 5;

/** Пауза между запросами к площадке. */
const PAUSE_MS = 1000;

/** Итог всего прогона. */
export type CrawlReport = {
  startedAt: string;
  sections: SectionReport[];
  /** Сколько объявлений перестало попадаться в выдаче в этом прогоне. */
  gone: number;
  /** Сколько живых объявлений в индексе после прогона. */
  live: number;
  /** Сколько помечено исчезнувшими за всё время. */
  goneTotal: number;
  /** Сколько объявлений собственников получили дату публикации. */
  dated: number;
  /** Площадка не ответила ни на один запрос — обход ничего не сделал. */
  unreachable: boolean;
};

/**
 * Дата публикации для собственников: отдельный проход по страницам
 * объявлений.
 *
 * Идёт ПОСЛЕ обхода выдачи и только для тех, кто похож на собственника:
 * остальным эта дата не нужна, а трафик чужого сайта не бесплатный.
 */
async function datePublications(limit: number): Promise<number> {
  const queue = await ownersWithoutDate(limit);
  let dated = 0;

  for (const item of queue) {
    await pause(PAUSE_MS);
    const html = await fetchSearchPage(item.url);
    if (html === null) continue;

    const page = parseListingPage(html);
    await setListingPage(item.id, page);
    if (page.postedAt) dated++;
  }

  return dated;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Один раздел: страницы по порядку, пока они отдают карточки.
 *
 * Пустая страница останавливает раздел: дальше у площадки ничего нет, и
 * оставшиеся запросы были бы потрачены впустую.
 */
async function crawlSection(
  deal: SectionReport['deal'],
  kind: SectionReport['kind'],
  path: string,
  city: string,
  town: number,
  startedAt: string,
): Promise<SectionReport> {
  const report: SectionReport = {
    deal, kind, city, pages: 0, cards: 0,
    added: 0, updated: 0, priceChanged: 0, gone: 0, skipped: {},
  };

  for (let page = 1; page <= PAGES_PER_SECTION; page++) {
    if (page > 1) await pause(PAUSE_MS);

    const html = await fetchSearchPage(searchUrl(path, town, page));
    if (html === null) break;

    report.pages++;
    const { cards, skipped } = parseSearchPage(html, deal);
    for (const [reason, n] of Object.entries(skipped)) {
      report.skipped[reason] = (report.skipped[reason] ?? 0) + n;
    }
    if (cards.length === 0) break;

    report.cards += cards.length;
    const saved = await saveCards(deal, kind, city, cards, bumpedOf);
    report.added += saved.added;
    report.updated += saved.updated;
    report.priceChanged += saved.priceChanged;
  }

  // Исчезнувшие помечаются ТОЛЬКО если раздел действительно прочитан.
  // Иначе первая же недоступность площадки объявила бы мёртвым весь
  // рынок разом — и оценка на следующий день считалась бы по пустому.
  if (report.pages > 0) {
    report.gone = await markGone(deal, kind, city, startedAt);
  }

  return report;
}

/** Момент последнего поднятия: берётся от «сейчас», как пишет площадка. */
function bumpedOf(card: MarketCard): string | null {
  return card.bumpedText ? bumpedAt(card.bumpedText, Date.now()) : null;
}

/** Весь обход: все разделы по всем известным городам. */
export async function crawlMarket(): Promise<CrawlReport> {
  const startedAt = now();
  const sections: SectionReport[] = [];

  for (const [city, town] of Object.entries(TOWNS)) {
    for (const section of SECTIONS) {
      if (sections.length > 0) await pause(PAUSE_MS);
      sections.push(
        await crawlSection(section.deal, section.kind, section.path, city, town, startedAt),
      );
    }
  }

  // Дата публикации — только если выдача вообще читалась. Когда
  // площадка лежит, незачем долбиться к ней ещё сорок раз подряд.
  const anyPages = sections.some((s) => s.pages > 0);
  const dated = anyPages ? await datePublications(LISTINGS_PER_RUN) : 0;

  const size = await marketSize();
  return {
    startedAt,
    sections,
    // Пометку исчезнувших делает каждый раздел сам; здесь их сумма за
    // этот прогон — её и читает человек в журнале.
    gone: sections.reduce((n, s) => n + s.gone, 0),
    live: size.live,
    goneTotal: size.gone,
    dated,
    // Ни одна страница не прочиталась — значит площадка закрылась или
    // сменила адреса. Это отдельный ответ, а не «прогон прошёл, нашли 0»:
    // ноль по недоступности и ноль по пустому рынку лечатся по-разному.
    unreachable: sections.every((s) => s.pages === 0),
  };
}
