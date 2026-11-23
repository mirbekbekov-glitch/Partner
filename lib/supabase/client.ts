import { createBrowserClient } from '@supabase/ssr';

/**
 * Клиент Supabase для клиентских компонентов.
 *
 * Координаты приходят аргументами, а не из process.env: значения с префиксом
 * NEXT_PUBLIC_ подставляются в код во время сборки, и сборка без них молча
 * кладёт пустые строки. Теперь их читает сервер в рантайме и передаёт
 * компоненту пропсами — см. lib/supabase/public-config.ts.
 */
export function createClient(url: string, anonKey: string) {
  return createBrowserClient(url, anonKey);
}
