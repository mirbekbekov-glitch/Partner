import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Клиент Supabase для серверных компонентов и server actions.
 *
 * Работает от имени ВОШЕДШЕГО агента, с анонимным ключом. Это важно:
 * инвариант 4 держится на построчных политиках, которые смотрят на
 * auth.uid(). Ключ service_role политики обходит, поэтому в кабинете он
 * не используется — иначе телефон собственника утёк бы любому агенту.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Вызов из серверного компонента: куки доступны только на чтение.
            // Обновление сессии произойдёт в middleware или в server action.
          }
        },
      },
    },
  );
}
