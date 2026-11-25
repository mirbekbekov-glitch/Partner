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

    // Журналы. Без них рассылка по расписанию — чёрный ящик: сработала она
    // или нет, видно только по тому, пришли ли напоминания. Включено здесь,
    // а не в панели: выкладка идёт с --force и затёрла бы правку, сделанную
    // мимо кода.
    observability: { enabled: true },

    // Рассылка напоминаний: 9:07 UTC ежедневно — то же время, что стояло в
    // vercel.json. В Бишкеке это 15:07: агент получает напоминание в
    // рабочий день, а не ночью.
    triggers: [triggers.scheduled({ schedule: '7 9 * * *' })],

    env: {
      ASSETS: bindings.assets(),

      // База. Заменяет Supabase целиком: таблицы, вход и журнал действий.
      //
      // Только имя: идентификатор необязателен, базу с таким именем
      // Cloudflare заводит сама при первой выкладке. Вписанный сюда
      // database_id привязал бы репозиторий к одному аккаунту.
      //
      // Привязка требует у токена выкладки прав D1:Edit — без них выкладка
      // падает на последнем шаге с «[10000] Authentication error». Один раз
      // это уже случилось; прод тогда уцелел, потому что падает шаг после
      // сборки, и прежний Worker остаётся на месте.
      DB: bindings.d1({ name: 'partner' }),

      // Фотографии объектов. Раньше агент вставлял ссылку на чужой хостинг,
      // и ссылка протухала вместе с чужим хостингом: вместо снимка
      // рисовался фасад.
      //
      // Ведро заводится само по имени. R2 — отдельная услуга, и пока она на
      // аккаунте не включена, Cloudflare отвечает «10042: Please enable R2
      // through the Cloudflare Dashboard», а выкладка падает общим
      // «[10000] Authentication error, 401», по которому причину не угадать.
      PHOTOS: bindings.r2({ name: 'partner-photos' }),

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
