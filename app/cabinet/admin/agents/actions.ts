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
 */
async function call(fn: string, args: Record<string, unknown>): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, args);
  revalidatePath('/cabinet/admin/agents');
  return { error: error ? error.message : null };
}

export async function approveAgent(formData: FormData): Promise<Result> {
  return call('approve_agent', { p_agent_id: String(formData.get('agent_id') ?? '') });
}

export async function blockAgent(formData: FormData): Promise<Result> {
  return call('block_agent', { p_agent_id: String(formData.get('agent_id') ?? '') });
}

export async function setAgentRole(formData: FormData): Promise<Result> {
  return call('set_agent_role', {
    p_agent_id: String(formData.get('agent_id') ?? ''),
    p_role: String(formData.get('role') ?? 'agent'),
  });
}
