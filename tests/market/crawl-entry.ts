/**
 * Точка входа ручной проверки обхода: см. tests/market/crawl.mjs.
 *
 * В прогон npm test НЕ входит — ходит в чужой интернет.
 */
import { setEnv } from '../d1/stubs/cloudflare-workers';
import { crawlMarket } from '@/lib/market/crawl';
import { all } from '@/lib/db/sql';

export default {
  async fetch(_request: Request, env: { DB: D1Database }): Promise<Response> {
    setEnv(env as unknown as Record<string, unknown>);

    const report = await crawlMarket();

    // Выборочно показать, что реально легло в базу: отчёт обхода считает
    // свои же действия, а здесь спрашиваем саму базу.
    const rows = await all<{
      deal_type: string; kind: string; rent_period: string | null;
      n: number; min_usd: number | null; max_usd: number | null;
      owners: number; with_area: number;
    }>(
      `select deal_type, kind, rent_period, count(*) as n,
              min(price_usd_minor) as min_usd, max(price_usd_minor) as max_usd,
              sum(case when seller_kind = 'owner' then 1 else 0 end) as owners,
              sum(case when area is not null then 1 else 0 end) as with_area
         from market_listings
        group by deal_type, kind, rent_period
        order by deal_type, kind`,
    );

    const sample = await all<{ url: string; address: string | null; price_kgs_minor: number | null }>(
      `select url, address, price_kgs_minor from market_listings limit 3`,
    );

    return Response.json({ report, rows, sample });
  },
};
