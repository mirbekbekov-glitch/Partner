/**
 * Черновик описания объекта: модель пишет, агент правит и подписывается.
 *
 * ГЛАВНОЕ ПРАВИЛО. Описание объявления — обещание покупателю. Выдуманный
 * «свежий ремонт» или «школа во дворе» это не стилистическая вольность, а
 * ложь в тексте, под которым стоит имя агентства. Поэтому модель получает
 * ТОЛЬКО заполненные поля карточки и запрет добавлять что-либо сверх них, а
 * результат попадает в поле формы, а не в базу: сохраняет его агент,
 * прочитав. Автопубликации машинного текста здесь нет и быть не должно.
 *
 * Модель вызывается через привязку Workers AI — `env.AI`. Ни ключа, ни
 * карты, ни внешнего ключа в переменных: Cloudflare выдаёт доступ самой
 * площадке. На бесплатном плане 10 000 нейронов в сутки, описание стоит
 * доли нейрона.
 */
import 'server-only';
import { env } from 'cloudflare:workers';

/**
 * Модель. Gemma 4 26B A4B: многоязычная из коробки (нам нужен русский),
 * доступна на бесплатном плане, 26 млрд параметров при 4 млрд активных —
 * отвечает быстро. Меняется переменной окружения, без правки кода.
 */
const MODEL = '@cf/google/gemma-4-26b-a4b-it';

/** Поля карточки, из которых пишется описание. */
export type ObjectSpec = {
  kind: string;
  deal_type: string;
  address: string | null;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floors_total: number | null;
  price: number | null;
  currency: string | null;
  /** Заметки агента: что он знает об объекте сверх полей формы. */
  notes: string | null;
};

const KIND_RU: Record<string, string> = {
  flat: 'квартира',
  room: 'комната',
  house: 'дом',
  townhouse: 'таунхаус',
  land: 'участок',
  commercial: 'коммерческое помещение',
  garage: 'гараж',
};

const SYSTEM = [
  'Ты пишешь описания объявлений недвижимости для агентства в Бишкеке.',
  '',
  'Жёсткие правила:',
  '1. Пиши ТОЛЬКО о том, что есть во входных данных. Не добавляй ни ремонт,',
  '   ни мебель, ни соседей, ни школы, ни парковку, ни вид из окна, ни',
  '   «развитую инфраструктуру», если этого нет во входных данных.',
  '   Нечего сказать — пиши короче.',
  '2. Не повторяй цену: она уже стоит рядом в карточке.',
  '3. Не обращайся к читателю и не зови звонить: кнопка заявки рядом.',
  '4. Без восклицательных знаков, эмодзи, КАПСА и слов «уникальный»,',
  '   «шикарный», «идеальный», «мечта».',
  '5. Два-четыре предложения, обычный русский язык, настоящее время.',
  '',
  'Верни только текст описания, без заголовка и без кавычек.',
].join('\n');

/** Входные данные для модели: только заполненные поля, человеческими словами. */
function brief(o: ObjectSpec): string {
  const lines: string[] = [
    `Тип: ${KIND_RU[o.kind] ?? o.kind}`,
    `Сделка: ${o.deal_type === 'rent' ? 'аренда' : 'продажа'}`,
  ];

  if (o.address) lines.push(`Адрес: ${o.address}`);
  if (o.zone) lines.push(`Район: ${o.zone}`);
  if (o.rooms) lines.push(`Комнат: ${o.rooms}`);
  if (o.area) lines.push(`Площадь: ${o.area} м²`);
  if (o.floor) {
    lines.push(`Этаж: ${o.floor}${o.floors_total ? ` из ${o.floors_total}` : ''}`);
  } else if (o.floors_total) {
    lines.push(`Этажей в доме: ${o.floors_total}`);
  }
  if (o.notes) lines.push(`Что добавил агент: ${o.notes}`);

  return lines.join('\n');
}

/**
 * Ответ Workers AI. Модели отдают текст по-разному: новые — в виде ответа
 * чата, старые — одним полем `response`. Разбираем оба вида, чтобы смена
 * модели не ломала кнопку.
 */
function answerOf(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const r = raw as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };
  if (typeof r?.response === 'string') return r.response;
  const content = r?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

export type DraftResult = { text: string | null; error: string | null };

export async function describeObject(o: ObjectSpec): Promise<DraftResult> {
  // Привязки нет — значит Worker собран без неё. Говорим прямо, что
  // настройка не доделана: это не вина агента и не его забота.
  const ai = (env as { AI?: Ai }).AI;
  if (!ai) {
    return {
      text: null,
      error: 'Генерация не настроена: нет привязки Workers AI. Напишите описание сами.',
    };
  }

  try {
    const raw = await ai.run(MODEL, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: brief(o) },
      ],
      // Размышления вслух нам не нужны: нужен готовый абзац, а не ход
      // мысли. Без этого модель возвращает рассуждение вперемешку с
      // ответом.
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: 400,
    });

    const clean = answerOf(raw).trim();
    if (!clean) return { text: null, error: 'Модель вернула пустой ответ. Попробуйте ещё раз.' };

    return { text: clean, error: null };
  } catch (e) {
    // Наружу — человеческая фраза, в журнал Worker — настоящая причина:
    // агенту нечего делать с текстом ошибки провайдера.
    console.error('describeObject:', e);
    return {
      text: null,
      error: 'Не удалось связаться с моделью. Попробуйте ещё раз или напишите описание сами.',
    };
  }
}
