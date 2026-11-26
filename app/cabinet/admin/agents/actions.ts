'use server';

import { revalidatePath } from 'next/cache';
import {
  approveAgent as approve, blockAgent as block,
  confirmAgentOrganization, setAgentRole as setRole,
} from '@/lib/db/agents';
import { attempt } from '@/lib/db/report';

type Result = { error: string | null };

/**
 * Одобрение, блокировка и роль.
 *
 * Проверка «только админ» живёт в слое доступа, а не здесь: действие формы
 * защищает только путь через форму. Там же живёт правило, что последнего
 * админа нельзя ни разжаловать, ни заблокировать — иначе систему можно
 * запереть так, что одобрять агентов станет некому.
 */
export async function approveAgent(formData: FormData): Promise<Result> {
  const error = await attempt(() => approve(String(formData.get('agent_id') ?? '')));
  revalidatePath('/cabinet/admin/agents');
  return { error };
}

export async function blockAgent(formData: FormData): Promise<Result> {
  const error = await attempt(() => block(String(formData.get('agent_id') ?? '')));
  revalidatePath('/cabinet/admin/agents');
  return { error };
}

export async function setAgentRole(formData: FormData): Promise<Result> {
  const error = await attempt(() => setRole(
    String(formData.get('agent_id') ?? ''),
    String(formData.get('role') ?? 'agent') === 'admin' ? 'admin' : 'agent',
  ));
  revalidatePath('/cabinet/admin/agents');
  return { error };
}

/**
 * Подтверждение принадлежности к агентству.
 *
 * Агент заявляет агентство сам — иначе он не зарегистрируется, — но
 * подтвердить может только админ. Иначе любой впишет «Этажи» и прикроется
 * чужой репутацией.
 */
export async function confirmAgentOrg(formData: FormData): Promise<Result> {
  const error = await attempt(() => confirmAgentOrganization(
    String(formData.get('agent_id') ?? ''),
    formData.get('confirmed') === 'true',
  ));
  if (error) return { error };

  revalidatePath('/cabinet/admin/agents');
  return { error: null };
}
