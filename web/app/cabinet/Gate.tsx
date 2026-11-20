import { me, type Me } from "../../lib/cabinet";

/**
 * Что показать, когда работать ещё нельзя.
 *
 * Пустой список и «нет доступа» для человека выглядят одинаково, поэтому
 * состояние называется словами. Неодобренный агент видит в базе ровно одну
 * строку — себя, — и это единственное, что ему можно сказать честно.
 */
export async function gate(): Promise<
  { ok: true; agent: Me } | { ok: false; screen: React.ReactNode }
> {
  const agent = await me();

  if (!agent) {
    return {
      ok: false,
      screen: (
        <div className="wrap narrow">
          <h1>Нужен вход</h1>
          <p className="lead">
            Кабинет открывается по номеру телефона и коду в WhatsApp.
          </p>
          <p><a className="btn" href="/cabinet/login">Войти</a></p>
        </div>
      ),
    };
  }

  if (agent.status === "pending") {
    return {
      ok: false,
      screen: (
        <div className="wrap narrow">
          <h1>Ждёте одобрения</h1>
          <p className="lead">
            Номер {agent.phone} подтверждён, учётная запись создана. Кабинет
            откроет администратор агентства — до этого данных агентства не
            видно, и это правило базы, а не настройка экрана.
          </p>
          <p className="muted">
            Если одобрение затягивается, позвоните администратору: он видит вас
            первым в списке агентов.
          </p>
        </div>
      ),
    };
  }

  if (agent.status === "blocked") {
    return {
      ok: false,
      screen: (
        <div className="wrap narrow">
          <h1>Доступ закрыт</h1>
          <p className="lead">
            Учётная запись заблокирована администратором агентства. Снять
            блокировку может только он.
          </p>
        </div>
      ),
    };
  }

  return { ok: true, agent };
}
