import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readSession } from "../../../lib/session";
import { channel, showsCodeOnScreen, transport } from "../../../lib/otp";
import { ActionForm } from "../ActionForm";
import { requestCode, submitCode } from "../actions";

export const metadata: Metadata = {
  title: "Вход в кабинет",
  robots: { index: false, follow: false },
};

export default async function LoginPage() {
  if (await readSession()) redirect("/cabinet");

  const byMail = channel() === "email";
  const label = byMail ? "Адрес почты" : "Номер телефона";
  const sample = byMail ? "aibek@pochta.kg" : "0700 123 456";
  const type = byMail ? "email" : "tel";
  const auto = byMail ? "email" : "tel";

  return (
    <div className="wrap narrow">
      <h1>Вход в кабинет</h1>
      <p className="lead">
        {byMail
          ? "Кабинет открывается по адресу почты. Адрес — это и есть учётная запись: один человек, один аккаунт, второй на тот же адрес не создать."
          : "Кабинет открывается по номеру телефона. Номер — это и есть учётная запись: один человек, один аккаунт, второй на тот же номер не создать."}
      </p>

      <section className="card">
        <h2>1. Получить код</h2>
        <ActionForm action={requestCode} label="Выслать код">
          <label>
            {label}
            <input
              name="address"
              type={type}
              placeholder={sample}
              autoComplete={auto}
              required
            />
          </label>
          <p className="hint">
            {byMail
              ? "Регистр и пробелы по краям не важны: адрес приводится к единому виду в базе."
              : "Можно в любом виде: 0700123456, 996700123456 или +996 700 123 456 — номер приводится к единому формату в базе."}
          </p>
        </ActionForm>
      </section>

      <section className="card">
        <h2>2. Ввести код</h2>
        <ActionForm action={submitCode} label="Войти">
          <label>
            {label}
            <input name="address" type={type} placeholder={sample} required />
          </label>
          <label>
            Код из письма
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
          <label>
            Телефон <span className="opt">— только при первом входе, можно позже</span>
            <input name="phone" type="tel" placeholder="0700 123 456" autoComplete="tel" />
          </label>
          <p className="hint">
            Код живёт 5 минут, работает один раз, и попыток на него пять. Это
            не строгость ради строгости: шестизначный код без ограничения
            подбирается за минуты.
          </p>
        </ActionForm>
      </section>

      {showsCodeOnScreen() && (
        <p className="warn-banner">
          Режим разработки: код не отправляется, а показывается здесь же и
          пишется в журнал сервера. В бою <code>OTP_TRANSPORT=email</code>, и
          экран кода не покажет. Этот режим нельзя оставлять в публичном
          вебе — код со страницы прочитает любой.
        </p>
      )}
      {transport() === "whatsapp" && (
        <p className="warn-banner">
          Выбран режим WhatsApp, но провайдер Business API не подключён:
          отправка кода завершится ошибкой. Смотрите <code>web/lib/otp.ts</code>.
        </p>
      )}

      <p className="muted">
        Новый агент после входа попадает в очередь на одобрение: кабинет
        открывает администратор агентства. Это тоже правило базы, а не
        настройка экрана. Телефон при регистрации записывается со слов —
        подтвердить его будет нечем, пока не подключён WhatsApp.
      </p>
    </div>
  );
}
