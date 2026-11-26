import Link from 'next/link';
import { sortHref, type Filters } from '@/lib/list-params';

/**
 * Заголовок сортируемой колонки.
 *
 * Серверный компонент: это обычная ссылка, состояние ей не нужно —
 * порядок живёт в адресе, и отсортированный список можно отправить
 * коллеге.
 *
 * Сортируются не все колонки. Там, где значение закрыто инвариантом 4
 * (собственник, клиент), сортировки нет намеренно: порядок строк выдал бы
 * то, что скрыто в самой ячейке. Нет её и у комиссии — она считается на
 * лету по правилу мандата, и в запросе такой колонки не существует.
 */
export function SortTh({
  base,
  f,
  col,
  label,
  className,
}: {
  base: string;
  f: Filters;
  col: string;
  label: string;
  className?: string;
}) {
  const active = f.sort === col;

  return (
    <th
      className={className}
      aria-sort={active ? (f.dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <Link className="th-sort" href={sortHref(base, f, col)}>
        {label}
        <span className="th-arrow" aria-hidden="true">
          {active ? (f.dir === 'asc' ? '↑' : '↓') : ''}
        </span>
      </Link>
    </th>
  );
}
