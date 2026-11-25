import { NextResponse } from 'next/server';
import { deletePhoto, putPhoto } from '@/lib/db/photos';
import { Forbidden } from '@/lib/db/errors';
import { explain } from '@/lib/db/report';

/**
 * Загрузка и удаление снимков объекта.
 *
 * Маршрут, а не server action: файл идёт потоком, и форма отправляет его
 * сама, без ожидания отрисовки. Права проверяет слой доступа — тот же
 * предикат, что и на правку объекта.
 */

/**
 * Код ответа по ТИПУ отказа, а не по тексту сообщения.
 *
 * Сперва я различал их по подстроке в тексте, и это неверно: стоит
 * переформулировать фразу — и отказ в правах начинает отвечать «400,
 * поправьте файл», а человек правит файл, который ни при чём.
 *
 * 403 браузеру незачем повторять, 400 человек исправит, выбрав другой
 * снимок.
 */
function fail(e: unknown): Response {
  const status = e instanceof Forbidden ? 403 : 400;
  return NextResponse.json({ error: explain(e) }, { status });
}
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const objectId = String(form.get('object_id') ?? '');
    const file = form.get('file');

    if (!objectId) {
      return NextResponse.json({ error: 'Не указан объект.' }, { status: 400 });
    }
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'Файл не пришёл.' }, { status: 400 });
    }

    // Миниатюра необязательна: старый браузер её не сделает, и это не
    // причина отказывать в загрузке снимка.
    const thumb = form.get('thumb');

    const stored = await putPhoto(objectId, file, thumb instanceof Blob ? thumb : null);
    return NextResponse.json(stored);
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(request: Request) {
  try {
    const { object_id: objectId, key } = await request.json() as {
      object_id?: string; key?: string;
    };

    if (!objectId || !key) {
      return NextResponse.json({ error: 'Не указан снимок.' }, { status: 400 });
    }

    await deletePhoto(objectId, key);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
