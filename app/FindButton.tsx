'use client';

import { useEffect, useRef, useState } from 'react';
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
 * чем отсутствие числа. Это обеспечено тем, что число приходит с сервера:
 * маршрут /api/catalog/count зовёт ту же функцию, что и страница.
 *
 * Раньше кнопка считала сама, обращаясь к базе прямо из браузера. С D1
 * так нельзя — до неё достаёт только Worker, — и это к лучшему: в браузере
 * не осталось ни ключей, ни знания о том, как устроена витрина.
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
      const params = new URLSearchParams({ deal });

      for (const key of ['kind', 'region', 'city', 'rooms', 'zone', 'from', 'to', 'q']) {
        const value = String(fd.get(key) ?? '').trim();
        if (value !== '') params.set(key, value);
      }

      try {
        const response = await fetch(`/api/catalog/count?${params}`, {
          headers: { accept: 'application/json' },
        });
        const data = await response.json() as { count: number | null };
        // Ошибку не показываем: на кнопке останется «Показать», и форма
        // отработает обычным путём. Счётчик — удобство, не обязательство.
        if (alive && typeof data.count === 'number') setCount(data.count);
      } catch {
        // То же самое: молчим и оставляем «Показать».
      }
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
