import { NextResponse } from 'next/server';
import { completeLogin } from '@/lib/db/login';
import { Forbidden } from '@/lib/db/errors';
import { siteUrl } from '@/lib/site';

/**
 * Приём ссылки из письма: токен в обмен на сессию.
 *
 * Заменяет сразу два прежних маршрута — /auth/callback и /auth/confirm, —
 * которые существовали только потому, что Supabase предлагала два разных
 * потока: один с ?code= и обменом через PKCE, другой с ?token_hash= и
 * переписанным шаблоном письма (платная возможность, которой у нас не
 * было). Своя ссылка этого выбора не требует.
 *
 * Маршрут, а не страница: здесь нужно поставить cookie и увести человека
 * дальше, а показывать нечего.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';

  try {
    const { agent, redirect_to } = await completeLogin(token);

    // Неодобренный агент входит, но попадает не в кабинет, а на экран
    // ожидания: сессия у него есть, доступа ещё нет. Это разные вещи.
    const target = agent.status === 'approved' ? redirect_to : '/cabinet';

    return NextResponse.redirect(new URL(target, url.origin));
  } catch (e) {
    const reason = e instanceof Forbidden
      ? e.message
      : 'Не удалось войти. Попробуйте запросить ссылку заново.';

    const back = new URL('/login', url.origin);
    back.searchParams.set('error', reason);
    return NextResponse.redirect(back);
  }
}

export { siteUrl };
