'use server';

import { redirect } from 'next/navigation';
import { endSession } from '@/lib/db/session';

/**
 * Выход.
 *
 * Снимает ТУ сессию, из которой вышли, и в браузере, и в базе. Остальные
 * устройства продолжают работать: выходить на одном и терять вход на
 * остальных человек не ожидает, а «выйти везде» — отдельное действие,
 * которого здесь пока нет.
 */
export async function signOut() {
  await endSession();
  redirect('/login');
}
