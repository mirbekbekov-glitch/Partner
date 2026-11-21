"use server";

import { revalidatePath } from "next/cache";
import { setOwnerPause } from "@/lib/report";

export type PauseResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Собственник приостанавливает или возобновляет показы.
 *
 * Проверок прав здесь нет: кто чем распоряжается, решает `app.owner_pause()`
 * по токену (инвариант 29). Задача этого файла — передать ответ базы
 * человеку словами.
 */
export async function pause(_prev: unknown, form: FormData): Promise<PauseResult> {
  const token = String(form.get("token"));
  const objectId = String(form.get("object_id"));
  const paused = String(form.get("paused")) === "1";
  const reason = String(form.get("reason") ?? "").trim();

  const result = await setOwnerPause(token, objectId, paused, reason || null);
  if (!result.ok) {
    return { ok: false, error: result.reason ?? "Не получилось." };
  }

  revalidatePath(`/owner/${token}`);
  return {
    ok: true,
    message: paused
      ? "Показы приостановлены. Агент это увидит, назначенные показы сняты."
      : "Показы возобновлены.",
  };
}
