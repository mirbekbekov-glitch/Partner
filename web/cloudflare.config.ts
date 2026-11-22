import { bindings, defineConfig, defineWorker } from "cf/config";

/**
 * Воркер Liberterra.
 *
 * Все значения объявлены через `bindings.secret()`, то есть приходят извне:
 * местно — из `.dev.vars`, в продакшне — из секретов воркера. В репозиторий не
 * попадает ни одно значение, но попадает их СПИСОК, и это главное: воркер,
 * которому не хватает переменной, ругается при запуске, а не отдаёт
 * наполовину работающий сайт. Раньше такой список существовал только в
 * `.env.example`, то есть на честном слове.
 */
export default defineConfig({
  worker: defineWorker({
    name: "liberterra",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-22",
    // pg, node:crypto (подписи сессий) и node:stream (отдача байтов) —
    // без этого флага воркер не соберётся.
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),

      // База. Роли — не украшение, а защита: каждая страница ходит в базу под
      // понижённой ролью, и RLS отдаёт только то, что этой роли позволено.
      DATABASE_URL: bindings.secret(),
      CATALOG_DB_ROLE: bindings.secret(),
      AUTH_DB_ROLE: bindings.secret(),
      CABINET_DB_ROLE: bindings.secret(),
      NOTIFY_DB_ROLE: bindings.secret(),

      // Подпись кук входа.
      SESSION_SECRET: bindings.secret(),

      // Ссылки в отчётах собственнику уходят наружу, поэтому адрес сайта
      // задаётся, а не угадывается из запроса.
      SITE_URL: bindings.secret(),

      // Доставка кодов входа и уведомлений: `dev` печатает в журнал.
      OTP_TRANSPORT: bindings.secret(),
      NOTIFY_TRANSPORT: bindings.secret(),

      // Хранилище фотографий.
      PHOTO_STORAGE: bindings.secret(),
      PHOTO_DIR: bindings.secret(),
    },
  }),
});
