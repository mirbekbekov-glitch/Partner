'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Building2,
  CalendarCheck,
  FileText,
  Handshake,
  Inbox,
  LayoutDashboard,
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

  // Перешли на другую страницу — меню на узком экране закрывается.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
            </>
          ) : null}
        </nav>

        <div className="crm-side-foot">
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
