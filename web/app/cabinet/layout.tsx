import { me } from "../../lib/cabinet";
import { logout } from "./actions";

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

  return (
    <div className="cabinet">
      <nav className="cab-nav">
        <div className="wrap">
          <a href="/cabinet" className="cab-brand">
            Кабинет
          </a>
          {agent?.status === "approved" && (
            <ul>
              <li><a href="/cabinet/objects">Объекты</a></li>
              <li><a href="/cabinet/inquiries">Обращения</a></li>
              <li><a href="/cabinet/requirements">Клиенты</a></li>
              <li><a href="/cabinet/showings">Показы</a></li>
              <li><a href="/cabinet/notifications">Уведомления</a></li>
              <li><a href="/cabinet/deals">Сделки</a></li>
              <li><a href="/cabinet/candidates">Площадки</a></li>
              {agent.is_admin && <li><a href="/cabinet/agents">Агенты</a></li>}
              {agent.is_admin && <li><a href="/cabinet/scheduler">Расписание</a></li>}
            </ul>
          )}
          <div className="cab-who">
            {agent ? (
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
            )}
          </div>
        </div>
      </nav>
      {children}
    </div>
  );
}
