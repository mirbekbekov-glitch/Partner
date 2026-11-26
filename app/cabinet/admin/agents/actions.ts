'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { inviteAgent } from '@/lib/db/invites';
import {
  approveAgent as approve, blockAgent as block,
  confirmAgentCertificate, confirmAgentOrganization, setAgentRole as setRole,
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

/**
 * Подтверждение номера в реестре риэлторов.
 *
 * Тот же порядок, что у агентства, и по той же причине: номер видит
 * клиент. Разница в цене ошибки — агентство это репутация чужой фирмы, а
 * сертификат это утверждение о квалификации, и проверить его клиент не
 * может вовсе.
 *
 * Админу стоит сверить номер с реестром, а не верить строке на экране:
 * строку вписал тот же человек, чью квалификацию она подтверждает.
 */
export async function confirmAgentCert(formData: FormData): Promise<Result> {
  const error = await attempt(() => confirmAgentCertificate(
    String(formData.get('agent_id') ?? ''),
    formData.get('confirmed') === 'true',
  ));
  if (error) return { error };

  revalidatePath('/cabinet/admin/agents');
  return { error: null };
}

export type InviteState = {
  link: string | null;
  email: string | null;
  full_name: string | null;
  existed: boolean;
  expires_at: string | null;
  error: string | null;
};

/**
 * Выдать приглашение.
 *
 * Ссылка возвращается в ответе действия и НИГДЕ не сохраняется: в базе
 * лежит только её хэш. Значит показать её можно один раз, и перезагрузка
 * страницы её теряет — это не недоделка, а то же свойство, что у ссылки
 * из письма.
 *
 * revalidatePath здесь нужен: приглашённый появляется в списке агентов
 * сразу, со статусом «ждёт одобрения».
 */
export async function inviteAgentLink(
  _prev: InviteState | null,
  formData: FormData,
): Promise<InviteState> {
  const empty = {
    link: null, email: null, full_name: null, existed: false, expires_at: null,
  };

  // Какой адрес у сайта, знает только запрос. Из переменной взять нельзя:
  // при проверке на другом адресе ссылка повела бы на боевой сайт.
  const incoming = await headers();
  const host = incoming.get('host') ?? '';
  const proto = incoming.get('x-forwarded-proto') ?? 'https';

  try {
    const invite = await inviteAgent({
      email: String(formData.get('email') ?? ''),
      full_name: String(formData.get('full_name') ?? ''),
      origin: `${proto}://${host}`,
    });
    revalidatePath('/cabinet/admin/agents');
    return { ...invite, error: null };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : 'Не вышло выдать ссылку.' };
  }
}
