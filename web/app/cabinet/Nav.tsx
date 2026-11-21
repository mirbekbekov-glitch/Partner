"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

export type NavItem = {
  href: string;
  label: string;
  /** Сколько дел требует внимания. 0 и null не показываются вовсе. */
  count?: number;
  /** Подпись к цифре: она объясняет, что именно горит. */
  hint?: string;
};

/**
 * Меню разделов — слева.
 *
 * Сначала оно было сверху, и не по решению, а по наследству: кабинет вырос
 * из шапки публичного каталога, когда разделов было шесть. На одиннадцати
 * горизонтальное меню ломается — на 1280 пикселях переносится на вторую
 * строку, а на телефоне листается вбок, и узнать, что в системе вообще
 * есть, нельзя не пролистав.
 *
 * Но переехало оно не из-за ширины. Рядом с пунктом слева помещается цифра,
 * а весь этот продукт устроен вокруг «что требует внимания»: четыре новых
 * обращения, два показа без исхода, просроченная задача. Раньше эти числа
 * жили только на главной, и агент узнавал о них, вернувшись на главную.
 *
 * Клиентский компонент здесь по двум причинам, и обе про телефон: панель
 * надо открывать и закрывать, и текущий раздел надо подсвечивать — иначе в
 * списке из одиннадцати пунктов непонятно, где стоишь.
 */
export function Nav({
  items,
  children,
}: {
  items: NavItem[];
  /** Кто вошёл и «Выйти». Приходит из серверной оболочки готовым куском. */
  children?: React.ReactNode;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  // Текущий раздел — самое длинное совпадение: иначе «/cabinet» подсветится
  // на каждой странице кабинета сразу.
  const current = items
    .filter((i) => path === i.href || path.startsWith(i.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  const total = items.reduce((n, i) => n + (i.count ?? 0), 0);

  return (
    <>
      <button
        type="button"
        className="nav-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Закрыть" : "Разделы"}
        {total > 0 && <span className="badge">{total}</span>}
      </button>

      <nav className={open ? "cab-side open" : "cab-side"} aria-label="Разделы кабинета">
        <ul>
          {items.map((i) => (
            <li key={i.href}>
              <a
                href={i.href}
                aria-current={i.href === current ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                <span>{i.label}</span>
                {i.count ? (
                  <span className="badge" title={i.hint}>{i.count}</span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
        <div className="cab-who">{children}</div>
      </nav>
    </>
  );
}
