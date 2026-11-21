'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

type Result = { error: string | null };

/**
 * Одобрение, блокировка и роль.
 *
 * Проверка «только админ» живёт в базе (app.approve_agent и соседние), а не
 * здесь: иначе её можно было бы обойти прямым запросом к PostgREST. Этот код
 * только передаёт вызов и показывает ответ.
 *
 * Имя функции написано в каждом вызове буквально, а не передано переменной:
 * tests/check-rpc.sh сверяет вызовы со схемой текстом, и через переменную
 * вызов для него невидим — а эту ошибку я уже делал.
 */
export async function approveAgent(formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('approve_agent', {
    p_agent_id: String(formData.get('agent_id') ?? ''),
  });
  revalidatePath('/cabinet/admin/agents');
  return { error: error ? error.message : null };
}

export async function blockAgent(formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('block_agent', {
    p_agent_id: String(formData.get('agent_id') ?? ''),
  });
  revalidatePath('/cabinet/admin/agents');
  return { error: error ? error.message : null };
}

export async function setAgentRole(formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_agent_role', {
    p_agent_id: String(formData.get('agent_id') ?? ''),
    p_role: String(formData.get('role') ?? 'agent'),
  });
  revalidatePath('/cabinet/admin/agents');
  return { error: error ? error.message : null };
}

/**
 * Подтверждение принадлежности к агентству.
 *
 * Агент заявляет агентство сам — иначе он не зарегистрируется, — но
 * подтвердить может только админ. Правило держит триггер в базе, здесь
 * только вызов и перевод отказа в человеческую фразу.
 */
export async function confirmAgentOrg(formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('confirm_agent_organization', {
    p_agent_id: String(formData.get('agent_id') ?? ''),
    p_confirmed: formData.get('confirmed') === 'true',
  });
  if (error) {
    return {
      error: error.message.includes('BAD_INPUT')
        ? 'Агент не указал агентство — подтверждать нечего.'
        : error.message.includes('FORBIDDEN')
          ? 'Подтверждать принадлежность может только администратор.'
          : error.message,
    };
  }
  revalidatePath('/cabinet/admin/agents');
  return { error: null };
}
