import { NextResponse } from 'next/server';
import { deletePanorama, putPanorama, renamePanorama } from '@/lib/db/panoramas';
import { Forbidden } from '@/lib/db/errors';
import { explain } from '@/lib/db/report';

/**
 * Панорамы объекта: загрузка, подпись комнаты, удаление.
 *
 * Маршрут, а не server action, по той же причине, что и у снимков: файл
 * идёт потоком и не ждёт отрисовки страницы. Права проверяет слой
 * доступа — тот же предикат, что и на правку объекта.
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

    if (!objectId) return NextResponse.json({ error: 'Не указан объект.' }, { status: 400 });
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'Файл не пришёл.' }, { status: 400 });
    }

    // Размеры считает браузер: в Worker'е картинку разобрать нечем, а
    // просмотрщику они нужны, чтобы не сплющить квартиру.
    const w = Number(form.get('w') ?? 0);
    const h = Number(form.get('h') ?? 0);

    const stored = await putPanorama(objectId, file, String(form.get('room') ?? ''), {
      w: Number.isFinite(w) ? w : 0,
      h: Number.isFinite(h) ? h : 0,
    });
    return NextResponse.json(stored);
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(request: Request) {
  try {
    const { object_id: objectId, key, room } = await request.json() as {
      object_id?: string; key?: string; room?: string;
    };
    if (!objectId || !key) {
      return NextResponse.json({ error: 'Не указана панорама.' }, { status: 400 });
    }

    const list = await renamePanorama(objectId, key, String(room ?? ''));
    return NextResponse.json({ panoramas: list });
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
      return NextResponse.json({ error: 'Не указана панорама.' }, { status: 400 });
    }

    await deletePanorama(objectId, key);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
