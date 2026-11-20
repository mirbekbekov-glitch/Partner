import { type EmailOtpType } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { safeNext } from '@/lib/next-param';

/**
 * Приём ссылки из письма.
 *
 * Этот маршрут работает только если шаблон письма переписан вручную на
 * {{ .TokenHash }} — а шаблоны писем Supabase отдаёт лишь на платных тарифах
 * или со своим SMTP. Рабочий путь по умолчанию — /auth/callback (поток PKCE,
 * родной шаблон). Этот оставлен для случая переписанного шаблона.
 *
 * Supabase присылает token_hash и type; verifyOtp обменивает их на сессию.
 * Сразу после этого создаём или находим строку агента через
 * app.ensure_agent() — иначе человек вошёл бы в Supabase Auth, но в CRM его
 * бы не существовало.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const next = safeNext(searchParams.get('next'));

  if (!token_hash || !type) {
    redirect(`/login?error=${encodeURIComponent('Ссылка неполная. Запросите вход заново.')}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash });

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
