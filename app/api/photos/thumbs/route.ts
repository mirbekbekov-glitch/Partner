import { NextResponse } from 'next/server';
import { photosMissingThumb, putThumb } from '@/lib/db/photos';
import { Forbidden, NotFound } from '@/lib/db/errors';
import { explain } from '@/lib/db/report';

/**
 * Пересчёт миниатюр.
 *
 * GET отдаёт снимки без миниатюр (только админу), POST принимает
 * миниатюру к уже лежащему снимку.
 *
 * Почему это маршрут, а не фоновое задание на сервере. Миниатюру делает
 * браузер — в Worker'е нет ни холста, ни кодировщика картинок, а
 * преобразование изображений у Cloudflare платное. Значит работу
 * выполняет открытая страница, а сервер только выдаёт список и
 * принимает готовое.
 */
function fail(e: unknown): Response {
  const status = e instanceof Forbidden ? 403 : e instanceof NotFound ? 404 : 400;
  return NextResponse.json({ error: explain(e) }, { status });
}

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const cursor = new URL(request.url).searchParams.get('cursor') ?? undefined;
    return NextResponse.json(await photosMissingThumb(cursor));
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const objectId = String(form.get('object_id') ?? '');
    const key = String(form.get('key') ?? '');
    const thumb = form.get('thumb');

    if (!objectId || !key) {
      return NextResponse.json({ error: 'Не указан снимок.' }, { status: 400 });
    }
    if (!(thumb instanceof Blob)) {
      return NextResponse.json({ error: 'Миниатюра не пришла.' }, { status: 400 });
    }

    await putThumb(objectId, key, thumb);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
