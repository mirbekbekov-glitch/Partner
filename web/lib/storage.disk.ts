/**
 * Хранилище на диске. Разработка и тесты.
 *
 * В продакшне не годится нигде: диск контейнера исчезает при следующем
 * выкладывании, и это одинаково верно на Vercel и на Cloudflare. В воркере
 * этот драйвер вообще не работает — запись отвечает «operation not
 * permitted», — и это не недоделка, а ровно то, чего от него и ждут.
 *
 * Файл никогда не вычисляется в воркере: `lib/storage.ts` импортирует его
 * отложенно и только когда PHOTO_STORAGE=disk.
 */

import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import type { Driver } from "./storage.ts";

function root(): string {
  const dir = process.env.PHOTO_DIR;
  if (!dir) {
    throw new Error(
      "PHOTO_DIR не задан: хранилищу фотографий негде лежать. Смотрите web/.env.example.",
    );
  }
  return dir;
}

/**
 * Путь файла в каталоге. Ключ уже ограничен проверкой схемы в базе —
 * проверяется ещё раз: обход каталога не должен зависеть от одной проверки.
 */
function path(key: string): string {
  const base = normalize(root());
  const full = join(base, normalize(key));
  if (!full.startsWith(base)) {
    throw new Error(`ключ ${key} выводит за пределы хранилища`);
  }
  return full;
}

export const driver: Driver = {
  async put(key, bytes) {
    const file = path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  },

  async read(key) {
    let file: string;
    try {
      file = path(key);
    } catch {
      return null;
    }
    try {
      const info = await stat(file);
      return {
        body: Readable.toWeb(createReadStream(file)) as unknown as ReadableStream,
        size: info.size,
        contentType: "image/webp",
      };
    } catch {
      return null;
    }
  },

  async remove(key) {
    try {
      await rm(path(key), { force: true });
    } catch (error) {
      console.error(`не удалось убрать файл ${key}: ${String(error)}`);
    }
  },
};
