import { NextResponse } from 'next/server';
import { deletePhoto, putPhoto } from '@/lib/db/photos';
import { explain } from '@/lib/db/report';

/**
 * Загрузка и удаление снимков объекта.
 *
 * Маршрут, а не server action: файл идёт потоком, и форма отправляет его
 * сама, без ожидания отрисовки. Права проверяет слой доступа — тот же
 * предикат, что и на правку объекта.
 */
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

    const stored = await putPhoto(objectId, file);
    return NextResponse.json(stored);
  } catch (e) {
    // Отказ по правам отличаем от неверного файла: 403 браузеру незачем
    // повторять, а 400 человек исправит, выбрав другой снимок.
    const message = explain(e);
    const status = message.includes('может тот, кто') ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
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
    const message = explain(e);
    const status = message.includes('может тот, кто') ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
