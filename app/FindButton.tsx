'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { searchTokens, tokenFilter } from '@/lib/catalog-params';
import { t, type Lang } from '@/lib/i18n';

/**
 * Кнопка поиска со счётчиком найденного.
 *
 * Человек крутит фильтры и видит число ДО перезагрузки: «Найти 12»
 * обещает выдачу, «Найти 0» честно говорит, что условия слишком узкие, и
 * избавляет от пустой страницы.
 *
 * Считает тот же публичный источник, что и страница, и теми же
 * условиями — иначе число на кнопке расходилось бы с выдачей, а это хуже,
 * чем отсутствие числа.
 *
 * Без JavaScript на кнопке остаётся «Показать», и форма работает как
 * работала: это надстройка, а не условие.
 */
export function FindButton({ lang, deal }: { lang: Lang; deal: 'sale' | 'rent' }) {
  const d = t(lang);
  const btn = useRef<HTMLButtonElement>(null);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const form = btn.current?.closest('form');
    if (!form) return;

    let timer: ReturnType<typeof setTimeout>;
    let alive = true;

    const recount = async () => {
      const fd = new FormData(form);
      const str = (k: string) => {
        const v = String(fd.get(k) ?? '').trim();
        return v === '' ? null : v;
      };
      const num = (k: string) => {
        const v = Number.parseInt(String(fd.get(k) ?? ''), 10);
        return Number.isFinite(v) && v > 0 ? v : null;
      };

      let q = createClient()
        .from('public_catalog_v')
        .select('id', { count: 'exact', head: true })
        .eq('deal_type', deal);

      const kind = str('kind');   if (kind) q = q.eq('kind', kind);
      const rooms = num('rooms'); if (rooms) q = q.eq('rooms', rooms);
      const zone = str('zone');   if (zone) q = q.eq('zone', zone);
      const from = num('from');   if (from) q = q.gte('price', from);
      const to = num('to');       if (to) q = q.lte('price', to);
      const text = str('q');
      if (text) for (const token of searchTokens(text)) q = q.or(tokenFilter(token));

      const { count: n, error } = await q;
      // Ошибку не показываем: на кнопке останется «Показать», и форма
      // отработает обычным путём. Счётчик — удобство, не обязательство.
      if (alive && !error && typeof n === 'number') setCount(n);
    };

    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(recount, 350);
    };

    recount();
    form.addEventListener('input', onChange);
    form.addEventListener('change', onChange);
    return () => {
      alive = false;
      clearTimeout(timer);
      form.removeEventListener('input', onChange);
      form.removeEventListener('change', onChange);
    };
  }, [deal]);

  return (
    <button className="go" type="submit" ref={btn}>
      {count === null ? d.search : d.searchCount(count)}
    </button>
  );
}
