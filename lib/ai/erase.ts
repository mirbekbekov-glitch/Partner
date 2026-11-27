import 'server-only';
import { env } from 'cloudflare:workers';

/**
 * Стереть предмет с куска снимка.
 *
 * ГРАНИЦА, которую этот модуль держит. Стирать можно то, что уедет
 * вместе с жильцами: людей, личные вещи, документы, мусор, провода,
 * сушилку с бельём. Нельзя — то, что останется покупателю: трещины,
 * плесень, потёки, вид из окна, соседний дом. Первое — уважение к
 * частной жизни, второе — обман на показе, за который ответит агентство.
 *
 * Машина эту границу не проверяет и проверить не может: отличить мешок
 * мусора от пятна сырости она не умеет. Поэтому правило записано в
 * подписи к кнопке, оригинал снимка хранится всегда, а объявление
 * сообщает, что с кадра стирали предметы. Проверяемость вместо запрета.
 *
 * Как это устроено. Браузер вырезает квадрат вокруг отмеченного места,
 * уменьшает до 512 и присылает сюда; модель дорисовывает это место;
 * браузер вставляет результат обратно в полный снимок. Целый снимок
 * модели не отдаётся намеренно: она перерисовала бы его весь, и квартира
 * перестала бы быть собой.
 */

/**
 * Модель. FLUX.2 klein 4B: правка изображения по образцу и описанию,
 * четыре шага — отвечает за секунды.
 *
 * Прежняя stable-diffusion-inpainting с маской снята с публикации
 * 20 ноября 2026 года, и это проверено запросом: Cloudflare отвечает
 * «Model has been deprecated». Поэтому маской здесь не стирают, а
 * описывают словами, что нужно убрать с ВЫРЕЗАННОГО куска.
 */
const MODEL = '@cf/black-forest-labs/flux-2-klein-4b';

const PROMPT = 'Remove the marked object from this interior photo. '
  + 'Continue the wall, floor and ceiling behind it naturally, '
  + 'keep the same lighting, colors, perspective and materials. '
  + 'Do not add any new furniture, people or decoration.';

export type EraseResult = { image: string | null; error: string | null };

/**
 * Кусок снимка без предмета.
 *
 * Возвращается base64-строка JPEG — её вставляет обратно браузер: в
 * Worker'е картинку собрать нечем, библиотеки изображений там нет.
 */
export async function erasePatch(patch: Blob): Promise<EraseResult> {
  const ai = (env as { AI?: Ai }).AI;
  if (!ai) {
    return { image: null, error: 'Обработка не настроена: нет привязки Workers AI.' };
  }

  try {
    const form = new FormData();
    form.append('prompt', PROMPT);
    form.append('input_image_0', patch, 'patch.jpg');
    form.append('width', '512');
    form.append('height', '512');

    // FormData сама по себе не отдаёт ни тела, ни границы разделителя:
    // их создаёт Response при сериализации. Без этого модель не разберёт
    // поля — так же устроен пример в документации Cloudflare.
    const serialized = new Response(form);

    const raw = await ai.run(MODEL, {
      multipart: {
        // Тип привязки ждёт здесь object: поток тела ему подходит, но
        // описан он шире, чем есть на самом деле.
        body: serialized.body as unknown as object,
        contentType: serialized.headers.get('content-type') ?? 'multipart/form-data',
      },
    });

    const image = (raw as { image?: string }).image;
    if (typeof image !== 'string' || image.length === 0) {
      return { image: null, error: 'Модель вернула пустой ответ. Попробуйте ещё раз.' };
    }

    return { image, error: null };
  } catch (e) {
    // Наружу — человеческая фраза, в журнал Worker — настоящая причина.
    console.error('erasePatch:', e);
    return { image: null, error: 'Не получилось обработать. Попробуйте ещё раз.' };
  }
}
