import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readSession } from "../../../lib/session";
import { showsCodeOnScreen, transport } from "../../../lib/otp";
import { ActionForm } from "../ActionForm";
import { requestCode, submitCode } from "../actions";

export const metadata: Metadata = {
  title: "Вход в кабинет",
  robots: { index: false, follow: false },
};

export default async function LoginPage() {
  if (await readSession()) redirect("/cabinet");

  return (
    <div className="wrap narrow">
      <h1>Вход в кабинет</h1>
      <p className="lead">
        Кабинет открывается по номеру телефона. Номер — это и есть учётная
        запись: один человек, один аккаунт, второй на тот же номер не создать.
      </p>

      <section className="card">
        <h2>1. Получить код</h2>
        <ActionForm action={requestCode} label="Выслать код">
          <label>
            Номер телефона
            <input
              name="phone"
              type="tel"
              placeholder="0700 123 456"
              autoComplete="tel"
              required
            />
          </label>
          <p className="hint">
            Можно в любом виде: 0700123456, 996700123456 или +996 700 123 456 —
            номер приводится к единому формату в базе.
          </p>
        </ActionForm>
      </section>

      <section className="card">
        <h2>2. Ввести код</h2>
        <ActionForm action={submitCode} label="Войти">
          <label>
            Номер телефона
            <input name="phone" type="tel" placeholder="0700 123 456" required />
          </label>
          <label>
            Код из WhatsApp
            <input
              name="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="123456"
              required
            />
          </label>
          <label>
            Имя и фамилия <span className="opt">— только при первом входе</span>
            <input name="full_name" placeholder="Айбек Асанов" autoComplete="name" />
          </label>
          <p className="hint">
            Код живёт 5 минут, работает один раз, и попыток на него пять. Это
            не строгость ради строгости: шестизначный код без ограничения
            подбирается за минуты.
          </p>
        </ActionForm>
      </section>

      {showsCodeOnScreen() && (
        <p className="warn">
          Режим разработки. Провайдер WhatsApp Business API ещё не выбран —
          это открытое решение, — поэтому код не отправляется, а показывается
          здесь же и пишется в журнал сервера. В бою{" "}
          <code>OTP_TRANSPORT=whatsapp</code>, и экран кода не покажет.
        </p>
      )}
      {transport() === "whatsapp" && (
        <p className="warn">
          Выбран режим WhatsApp, но провайдер не подключён: отправка кода
          завершится ошибкой. Смотрите <code>web/lib/otp.ts</code>.
        </p>
      )}

      <p className="muted">
        Новый агент после входа попадает в очередь на одобрение: кабинет
        открывает администратор агентства. Это тоже правило базы, а не
        настройка экрана.
      </p>
    </div>
  );
}
