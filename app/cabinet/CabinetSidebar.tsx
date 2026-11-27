'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Building2,
  Calculator,
  CalendarCheck,
  FileText,
  Handshake,
  Image as ImageIcon,
  Inbox,
  ExternalLink,
  LayoutDashboard,
  Store,
  Menu,
  Target,
  User,
  Users,
  UserCog,
  X,
} from 'lucide-react';

/**
 * Боковое меню кабинета.
 *
 * Клиентский компонент, потому что подсветка активного пункта читает путь,
 * а мобильное меню хранит «открыто/закрыто». Значки объявлены здесь же:
 * через границу RSC из серверного layout компонент-функцию не передать.
 * Выход приходит готовым элементом через `footer` — серверное действие
 * остаётся на сервере.
 */
const ITEMS = [
  { href: '/cabinet', label: 'Кабинет', icon: LayoutDashboard, exact: true },
  { href: '/cabinet/contacts', label: 'Контакты', icon: Users },
  { href: '/cabinet/objects', label: 'Объекты', icon: Building2 },
  { href: '/cabinet/requirements', label: 'Потребности', icon: Target },
  { href: '/cabinet/deals', label: 'Сделки', icon: Handshake },
  { href: '/cabinet/activities', label: 'Задачи', icon: CalendarCheck },
  { href: '/cabinet/leads', label: 'По объектам', icon: Activity },
  { href: '/cabinet/requests', label: 'Заявки', icon: Inbox },
  { href: '/cabinet/assistant', label: 'Оценка', icon: Calculator },
] as const;

export function CabinetSidebar({
  fullName,
  isAdmin,
  footer,
}: {
  fullName: string | null;
  isAdmin: boolean;
  footer: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const burgerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Перешли на другую страницу — меню на узком экране закрывается.
  useEffect(() => setOpen(false), [pathname]);

  // Пока меню открыто: Escape закрывает, фон под ним не прокручивается,
  // а при расширении окна до десктопного меню закрывается само — иначе
  // блокировка прокрутки осталась бы без видимой причины.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const wide = window.matchMedia('(min-width: 901px)');
    const onWide = () => wide.matches && setOpen(false);
    window.addEventListener('keydown', onKey);
    wide.addEventListener('change', onWide);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onWide);
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Фокус уходит в меню при открытии и возвращается на кнопку при закрытии.
  useEffect(() => {
    if (open) closeRef.current?.focus();
    else if (wasOpen.current) burgerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(href + '/');

  const link = (href: string, label: string, Icon: typeof FileText, exact?: boolean) => (
    <Link
      key={href}
      href={href}
      className="crm-link"
      aria-current={isActive(href, exact) ? 'page' : undefined}
    >
      <Icon size={18} aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );

  return (
    <>
      <div className="crm-mobilebar">
        <button
          ref={burgerRef}
          type="button"
          className="crm-burger"
          aria-label="Открыть меню"
          aria-expanded={open}
          aria-controls="crm-sidebar"
          onClick={() => setOpen(true)}
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        <span className="crm-mobilebar-title">Кабинет</span>
      </div>

      {open ? <div className="crm-backdrop" onClick={() => setOpen(false)} /> : null}

      <aside id="crm-sidebar" className="crm-sidebar" data-open={open ? 'true' : 'false'}>
        <div className="crm-side-head">
          <span className="crm-side-title">Liberterra CRM</span>
          <button
            ref={closeRef}
            type="button"
            className="crm-close"
            aria-label="Закрыть меню"
            onClick={() => setOpen(false)}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <nav className="crm-nav" aria-label="Разделы кабинета">
          {ITEMS.map((i) => link(i.href, i.label, i.icon, 'exact' in i ? i.exact : false))}
          {isAdmin ? (
            <>
              <span className="crm-nav-sep">Администратор</span>
              {link('/cabinet/admin/agents', 'Агенты', UserCog)}
              {link('/cabinet/admin/photos', 'Миниатюры', ImageIcon)}
            </>
          ) : null}
        </nav>

        <div className="crm-side-foot">
          {/* Публичный каталог. Обычная <a>, а не Link: переход в новую
              вкладку, чтобы открытый кабинет не терялся, когда агент ушёл
              смотреть витрину глазами клиента. Адрес корневой — язык
              подставит редирект. */}
          <a href="/" className="crm-link" target="_blank" rel="noopener">
            <Store size={18} aria-hidden="true" />
            <span>Каталог</span>
            <ExternalLink size={14} aria-hidden="true" className="crm-link-out" />
          </a>
          <Link
            href="/cabinet/profile"
            className="crm-link"
            aria-current={isActive('/cabinet/profile') ? 'page' : undefined}
          >
            <User size={18} aria-hidden="true" />
            <span className="crm-me">{fullName ?? 'Профиль'}</span>
            {isAdmin ? <span className="tag">админ</span> : null}
          </Link>
          {footer}
        </div>
      </aside>
    </>
  );
}
