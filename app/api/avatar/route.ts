import { NextResponse } from 'next/server';
import { deleteAvatar, putAvatar } from '@/lib/db/photos';
import { Forbidden } from '@/lib/db/errors';
import { explain } from '@/lib/db/report';

/**
 * Аватарка агента.
 *
 * Отдельный маршрут от снимков объектов: там права считает мандат и есть
 * лимит на объект, здесь аватарка своя и одна. Общий маршрут пришлось бы
 * ветвить по типу — и однажды ветка ошиблась бы.
 *
 * Правит агент только свою: идентификатор берётся из сессии, а не из
 * запроса, и подменить его нечем.
 */
function fail(e: unknown): Response {
  const status = e instanceof Forbidden ? 403 : 400;
  return NextResponse.json({ error: explain(e) }, { status });
}

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get('file');

    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'Файл не пришёл.' }, { status: 400 });
    }

    return NextResponse.json(await putAvatar(file));
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE() {
  try {
    await deleteAvatar();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
