'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type RequestActionResult = { error: string | null };

/**
 * Действия над заявкой.
 *
 * Права и состояния проверяет база: take_request(), close_request() и
 * остальные знают, кто ведёт заявку и в каком она состоянии. Здесь только
 * перевод кода отказа в человеческую фразу.
 */
const SAY: Record<string, string> = {
  TAKEN: 'Заявку уже взял другой агент.',
  DENIED: 'Это чужая заявка.',
  BAD_INPUT: 'Проверьте, что вы ввели.',
};

function say(message: string): string {
  for (const [code, phrase] of Object.entries(SAY)) {
    if (message.includes(code)) return phrase;
  }
  return message;
}

/**
 * Имя функции в каждом вызове написано БУКВАЛЬНО, а не подставлено
 * переменной. Так чуть длиннее, зато tests/check-rpc.sh видит, что именно
 * вызывает кабинет, и ловит расхождение с базой до рантайма: спрятав имена
 * за общий помощник, я сломал эту сверку и узнал бы о переименованной
 * функции только от агента, у которого упала страница.
 */
function done(error: { message: string } | null): RequestActionResult {
  if (error) return { error: say(error.message) };
  revalidatePath('/cabinet/requests');
  revalidatePath('/cabinet');
  return { error: null };
}

export async function takeRequest(formData: FormData): Promise<RequestActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('take_request', {
    p_id: String(formData.get('id') ?? ''),
  });
  return done(error);
}

export async function releaseRequest(formData: FormData): Promise<RequestActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('release_request', {
    p_id: String(formData.get('id') ?? ''),
  });
  return done(error);
}

export async function answerRequest(formData: FormData): Promise<RequestActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('answer_request', {
    p_id: String(formData.get('id') ?? ''),
    p_note: String(formData.get('note') ?? ''),
  });
  return done(error);
}

export async function closeRequest(formData: FormData): Promise<RequestActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('close_request', {
    p_id: String(formData.get('id') ?? ''),
    p_reason: String(formData.get('reason') ?? ''),
  });
  return done(error);
}

export async function convertRequest(formData: FormData): Promise<RequestActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('convert_request', {
    p_id: String(formData.get('id') ?? ''),
  });
  return done(error);
}
