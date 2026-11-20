import { redirect } from 'next/navigation';
import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { safeNext } from '@/lib/next-param';

/**
 * Приём ссылки из письма — поток PKCE, родной шаблон письма.
 *
 * Родное письмо Supabase ведёт на свой /auth/v1/verify, тот проверяет токен и
 * редиректит сюда с ?code=. Обмен кода на сессию требует code_verifier,
 * который @supabase/ssr положил в cookie при отправке письма: поэтому ссылку
 * нужно открывать в том же браузере, откуда её запросили.
 *
 * Второй маршрут, /auth/confirm, ждёт token_hash и работает только если
 * шаблон письма переписан вручную. Шаблоны — платная возможность Supabase,
 * поэтому рабочий путь по умолчанию здесь.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = safeNext(searchParams.get('next'));

  // Supabase сообщает об отказе в самой ссылке (срок истёк, ссылку уже
  // использовали). Без этой ветки человек увидел бы «ссылка неполная».
  const errorDescription = searchParams.get('error_description');
  if (errorDescription) {
    redirect(`/login?error=${encodeURIComponent(errorDescription)}`);
  }

  if (!code) {
    redirect(`/login?error=${encodeURIComponent('Ссылка неполная. Запросите вход заново.')}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  // Строка агента. Имя не передаём: ensure_agent подставит почту, а
  // настоящее имя агент впишет сам — повторный вход его не затрёт.
  const { error: agentError } = await supabase.rpc('ensure_agent');
  if (agentError) {
    redirect(`/login?error=${encodeURIComponent(agentError.message)}`);
  }

  redirect(next);
}
