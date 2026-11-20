import Link from 'next/link';
import { PAGE_SIZE, pageHref, type Filters } from '@/lib/list-params';

export function Pager({
  base,
  filters,
  total,
}: {
  base: string;
  filters: Filters;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;

  const from = (filters.page - 1) * PAGE_SIZE + 1;
  const to = Math.min(filters.page * PAGE_SIZE, total);

  return (
    <div className="pager">
      <span className="key">
        {from}–{to} из {total}
      </span>
      {filters.page > 1 ? (
        <Link href={pageHref(base, filters, filters.page - 1)}>← назад</Link>
      ) : null}
      {filters.page < pages ? (
        <Link href={pageHref(base, filters, filters.page + 1)}>вперёд →</Link>
      ) : null}
    </div>
  );
}
