import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Обновление сессии на каждом запросе.
 *
 * Без этого access-token истекает и серверные компоненты начинают видеть
 * анонима, хотя человек залогинен. Обновлённые куки надо писать и в запрос
 * (чтобы их увидел текущий рендер), и в ответ (чтобы браузер их сохранил).
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser(), а не getSession(): только он проверяет токен на сервере Supabase.
  // getSession() доверяет куке, то есть содержимому, которое пришло из браузера.
  const { data: { user } } = await supabase.auth.getUser();

  // Кабинет закрыт для неаутентифицированных. Решение о том, одобрен ли
  // агент, принимает layout кабинета — здесь только наличие сессии.
  if (!user && request.nextUrl.pathname.startsWith('/cabinet')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  return response;
}
