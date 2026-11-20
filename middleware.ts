import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Перечислением, а не «всё кроме статики»: обновление сессии ходит в
  // Supabase на каждом запросе, и на публичном каталоге это был бы лишний
  // сетевой вызов на каждый просмотр страницы анонимом. Токен агента
  // обновится, как только он откроет кабинет.
  matcher: ['/cabinet/:path*', '/login', '/auth/:path*'],
};
