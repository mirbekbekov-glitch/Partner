/**
 * Разбор ЖИВОЙ страницы house.kg. Запускается руками.
 *
 * Зачем он нужен отдельно от основного прогона. Тесты в tests/d1 читают
 * СНИМОК страницы, сохранённый в tests/fixtures. Снимок не меняется, и
 * поэтому на нём разбор зелёный навсегда — даже когда площадка полностью
 * переписала вёрстку и настоящий разбор уже ничего не находит.
 *
 * Эта проверка берёт страницу сегодняшнюю. Она НЕ входит в npm test
 * намеренно: прогон, зависящий от чужого сайта, краснел бы от чужих
 * неполадок, и люди привыкли бы к красному.
 *
 * Запуск:
 *   npx esbuild lib/market/house-kg.ts --bundle --format=esm --outfile=/tmp/hk.mjs
 *   node tests/market/live.mjs /tmp/hk.mjs
 *
 * Что считать поломкой: «отброшено» заметно больше нуля, пустой разбор
 * при ответе 200, либо все продавцы вдруг стали unknown.
 */
const modulePath = process.argv[2];
if (!modulePath) {
  console.error('нужен путь к собранному модулю: node tests/market/live.mjs /tmp/hk.mjs');
  process.exit(2);
}

const { SECTIONS, TOWNS, fetchSearchPage, parseSearchPage, searchUrl } =
  await import(modulePath);

let bad = 0;

for (const section of SECTIONS) {
  const url = searchUrl(section.path, TOWNS['Бишкек']);
  const html = await fetchSearchPage(url);

  if (html === null) {
    console.log(`  НЕ ОТВЕТИЛА  ${section.deal}/${section.kind}  ${url}`);
    bad++;
    continue;
  }

  const { cards, skipped } = parseSearchPage(html, section.deal);
  const owners = cards.filter((c) => c.sellerKind === 'owner').length;
  const agencies = cards.filter((c) => c.sellerKind === 'agency').length;
  const priced = cards.filter((c) => c.priceUsd || c.priceKgs).length;
  const daily = cards.filter((c) => c.period === 'day').length;

  const note = Object.keys(skipped).length ? `  отброшено ${JSON.stringify(skipped)}` : '';
  console.log(
    `  ${cards.length === 0 ? 'ПУСТО       ' : 'ok          '}`
    + `${section.deal}/${section.kind}: карточек ${cards.length}, с ценой ${priced}, `
    + `собственников ${owners}, агентств ${agencies}`
    + `${daily ? `, посуточных ${daily}` : ''}${note}`,
  );

  if (cards.length === 0) bad++;

  // Пауза: сорок быстрых запросов подряд — поведение, от которого
  // площадки и закрываются.
  await new Promise((r) => setTimeout(r, 1000));
}

console.log(bad === 0 ? '\n  живая страница разбирается' : `\n  разделов с бедой: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
