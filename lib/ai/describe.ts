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
 * Почему через шлюз, а не напрямую к провайдеру: шлюз держит запасные
 * модели на случай сбоя одного провайдера и один счёт на всё. Ключ
 * (AI_GATEWAY_API_KEY) на Vercel подставляется платформой.
 */
import 'server-only';
import { generateText } from 'ai';

/**
 * Модель. Haiku: задача — четыре предложения по десятку полей, думать тут
 * не над чем, а разница в цене со старшими моделями полусотенная. Меняется
 * переменной окружения, без правки кода.
 */
const MODEL = process.env.AI_DESCRIPTION_MODEL ?? 'anthropic/claude-haiku-5.5';

/** Поля карточки, из которых пишется описание. Все необязательные, кроме вида и сделки. */
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

const INSTRUCTIONS = [
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

export type DraftResult = { text: string | null; error: string | null };

export async function describeObject(o: ObjectSpec): Promise<DraftResult> {
  // Без ключа шлюз ответит 401, а агент увидит невнятную ошибку. Говорим
  // прямо, что настройка не доделана, — это не его вина и не его забота.
  if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
    return {
      text: null,
      error: 'Генерация не настроена: нет доступа к AI Gateway. Напишите описание сами.',
    };
  }

  try {
    const { text } = await generateText({
      model: MODEL,
      instructions: INSTRUCTIONS,
      prompt: brief(o),
    });

    const clean = text.trim();
    if (!clean) return { text: null, error: 'Модель вернула пустой ответ. Попробуйте ещё раз.' };

    return { text: clean, error: null };
  } catch (e) {
    // Наружу — человеческая фраза, в журнал сервера — настоящая причина:
    // агенту нечего делать с текстом ошибки провайдера.
    console.error('describeObject:', e);
    return { text: null, error: 'Не удалось связаться с моделью. Попробуйте ещё раз или напишите описание сами.' };
  }
}
