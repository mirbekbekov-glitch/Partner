import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/**
 * Клиент с ключом service_role: обходит RLS.
 *
 * Использовать ТОЛЬКО в фоновых заданиях, которые действуют не от имени
 * агента. В кабинете он запрещён: инвариант 4 держится на политиках, а
 * service_role их игнорирует — через него телефон собственника утёк бы
 * любому агенту.
 *
 * Единственный нынешний потребитель — рассылка напоминаний: она работает
 * сразу за всех агентов, поэтому сессии у неё нет и быть не может.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Для фонового задания нужны NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY',
    );
  }

  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
