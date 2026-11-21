import { alerts, me } from "../../lib/cabinet";
import { logout } from "./actions";
import { Nav, type NavItem } from "./Nav";

/**
 * Оболочка кабинета.
 *
 * Здесь нет проверки «пустил ли», и это сознательно: пустить или нет решает
 * база — политиками и функциями. Оболочка показывает состояние, которое
 * база вернула, и ровно три состояния бывает: входа нет, вход есть и человек
 * ждёт одобрения, вход есть и человек работает.
 */
export default async function CabinetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const agent = await me();
  // Сводку спрашиваем только у работающего агента: у ждущего одобрения меню
  // нет вовсе, и лишний запрос на каждой странице входа ни к чему.
  const a = agent?.status === "approved" ? await alerts() : null;

  const items: NavItem[] = agent?.status === "approved"
    ? [
        { href: "/cabinet", label: "Главная" },
        { href: "/cabinet/inquiries", label: "Обращения",
          count: a?.inquiries_new, hint: "новых, ещё не разобрали" },
        { href: "/cabinet/requirements", label: "Клиенты" },
        { href: "/cabinet/selections", label: "Подборки" },
        { href: "/cabinet/funnel", label: "Воронка",
          count: a?.funnel_stuck, hint: "стоят в колонке дольше положенного" },
        { href: "/cabinet/tasks", label: "Задачи",
          count: a?.tasks_overdue, hint: "просрочено" },
        { href: "/cabinet/showings", label: "Показы",
          count: a?.showings_overdue, hint: "без исхода: время прошло" },
        { href: "/cabinet/deals", label: "Сделки",
          count: a?.deals_stuck, hint: "стоят на этапе дольше отведённого" },
        { href: "/cabinet/listings", label: "Объекты в работе" },
        { href: "/cabinet/objects", label: "Объекты",
          count: a?.objects_critical, hint: "просроченный договор или давно не подтверждали" },
        { href: "/cabinet/notifications", label: "Уведомления",
          count: a?.notifications_stuck, hint: "не ушли: канал не принял" },
        // «Объявления» — то, что приносим С площадок; «Площадки» — то, что
        // отдаём туда. Пока в меню стояли два пункта с одним названием,
        // различить их можно было только методом тыка.
        { href: "/cabinet/candidates", label: "Объявления" },
        { href: "/cabinet/channels", label: "Площадки",
          count: a?.channels_not_ready, hint: "включены, но фид не соберётся" },
        ...(agent.is_admin
          ? [
              { href: "/cabinet/agents", label: "Агенты",
                count: a?.agents_pending, hint: "ждут одобрения" },
              { href: "/cabinet/scheduler", label: "Расписание",
                count: a?.scheduler_broken, hint: "работа молчит дольше своего срока" },
            ]
          : []),
      ]
    : [];

  // Бренд в кабинете не повторяется: он уже стоит в шапке сайта сверху.
  // Две полосы подряд с одним и тем же названием — не навигация, а эхо.
  const who = agent ? (
    <>
      <a href="/cabinet/profile">
        {agent.full_name}
        {agent.is_admin && <span className="chip admin">админ</span>}
      </a>
      <form action={logout}>
        <button type="submit" className="link">Выйти</button>
      </form>
    </>
  ) : (
    <a href="/cabinet/login">Войти</a>
  );

  if (items.length === 0) {
    return (
      <div className="cabinet">
        <div className="cab-bare">{who}</div>
        {children}
      </div>
    );
  }

  return (
    <div className="cabinet">
      <div className="cab-shell">
        <Nav items={items}>{who}</Nav>
        <div className="cab-main">{children}</div>
      </div>
    </div>
  );
}
