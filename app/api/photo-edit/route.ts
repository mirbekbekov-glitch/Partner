import { NextResponse } from 'next/server';
import { erasePatch } from '@/lib/ai/erase';
import { restoreOriginal, saveEdited } from '@/lib/db/photo-edits';
import { canEditObject } from '@/lib/db/access';
import { currentAgent } from '@/lib/db/session';
import { Forbidden } from '@/lib/db/errors';
import { explain } from '@/lib/db/report';

/**
 * Обработка снимков: стереть предмет, сохранить результат, вернуть
 * оригинал.
 *
 * Три действия на одном маршруте, потому что это один разговор браузера
 * с сервером об одном снимке. Права на все три одинаковые — те же, что
 * на правку объекта.
 *
 * Модель видит только ВЫРЕЗАННЫЙ кусок, а не весь снимок: целый кадр она
 * перерисовала бы целиком, и квартира перестала бы быть собой. Сборку
 * делает браузер — в Worker'е картинку собрать нечем.
 */

function fail(e: unknown): Response {
  const status = e instanceof Forbidden ? 403 : 400;
  return NextResponse.json({ error: explain(e) }, { status });
}

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const what = String(form.get('what') ?? '');
    const objectId = String(form.get('object_id') ?? '');

    if (!objectId) return NextResponse.json({ error: 'Не указан объект.' }, { status: 400 });

    // Проверка на агента — отдельной строкой: стирание ходит в модель,
    // то есть НАРУЖУ, мимо слоя доступа, и без неё любой, кто дотянулся
    // до маршрута, тратил бы чужие деньги на обработку.
    if (!(await currentAgent())) {
      return NextResponse.json({ error: 'Обработка доступна агентам.' }, { status: 403 });
    }
    if (!(await canEditObject(objectId))) {
      return NextResponse.json(
        { error: 'Обрабатывать снимки может тот, кто отвечает за объект.' },
        { status: 403 },
      );
    }

    if (what === 'erase') {
      const patch = form.get('patch');
      if (!(patch instanceof Blob)) {
        return NextResponse.json({ error: 'Кусок снимка не пришёл.' }, { status: 400 });
      }
      const result = await erasePatch(patch);
      if (!result.image) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      return NextResponse.json({ image: result.image });
    }

    if (what === 'save') {
      const file = form.get('file');
      const original = String(form.get('original') ?? '');
      if (!(file instanceof Blob) || !original) {
        return NextResponse.json({ error: 'Нечего сохранять.' }, { status: 400 });
      }
      const edit = await saveEdited(objectId, original, file, form.get('erased') === '1');
      return NextResponse.json(edit);
    }

    if (what === 'restore') {
      await restoreOriginal(objectId, String(form.get('url') ?? ''));
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Неизвестное действие.' }, { status: 400 });
  } catch (e) {
    return fail(e);
  }
}
