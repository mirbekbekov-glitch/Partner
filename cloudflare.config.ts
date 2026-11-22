/**
 * Worker: что он такое, по какому расписанию просыпается и что ему доступно.
 *
 * Это замена vercel.json и панели переменных Vercel сразу: здесь и
 * расписание рассылки, и список секретов, которые Worker ждёт от платформы.
 */
import { bindings, defineConfig, defineWorker, triggers } from 'cf/config';

export default defineConfig({
  worker: defineWorker({
    name: 'partner',

    // Своя точка входа, а не vinext/server/fetch-handler напрямую: у
    // платформы нет способа вызвать HTTP-маршрут по расписанию, нужен
    // scheduled(). Запросы посетителей worker/index.ts передаёт тому же
    // обработчику vinext, ничего не меняя.
    entrypoint: './worker/index.ts',

    compatibilityDate: '2026-11-22',

    // Node-совместимость нужна библиотекам Supabase и генератору карточки
    // превью: без неё Worker падает на отсутствующих модулях Node.
    compatibilityFlags: ['nodejs_compat'],

    assets: {
      htmlHandling: 'none',
      notFoundHandling: 'none',
      runWorkerFirst: ['/*', '!/_next/static/*', '!/*/_next/static/*'],
    },

    // Рассылка напоминаний: 9:07 UTC ежедневно — то же время, что стояло в
    // vercel.json. В Бишкеке это 15:07: агент получает напоминание в
    // рабочий день, а не ночью.
    triggers: [triggers.scheduled({ schedule: '7 9 * * *' })],

    env: {
      ASSETS: bindings.assets(),

      // Workers AI: модель вызывается через эту привязку, без ключа и без
      // карты. Ради этого и затевался переезд.
      AI: bindings.ai(),

      // Публичные значения Supabase. Анонимный ключ рассчитан на то, что
      // данные защищены RLS, а не секретностью ключа, — но хранить его
      // всё равно удобнее вместе с остальными.
      NEXT_PUBLIC_SUPABASE_URL: bindings.secret(),
      NEXT_PUBLIC_SUPABASE_ANON_KEY: bindings.secret(),

      // Собственный адрес сайта: нужен карте сайта и превью при пересылке.
      NEXT_PUBLIC_SITE_URL: bindings.secret(),

      // Секреты фоновых заданий. service_role обходит RLS, поэтому живёт
      // только здесь и в app/api.
      SUPABASE_SERVICE_ROLE_KEY: bindings.secret(),
      CRON_SECRET: bindings.secret(),
      TELEGRAM_BOT_TOKEN: bindings.secret(),
    },
  }),
});
