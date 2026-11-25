import { readFileSync } from 'node:fs';

/**
 * Схема → список отдельных команд.
 *
 * Общий модуль для прогона тестов и для применения схемы в боевую базу:
 * резать схему они обязаны одинаково, иначе проверенное локально и
 * выложенное наружу разойдутся.
 *
 * Комментарии снимаются ДО разбиения. В пояснениях встречается точка с
 * запятой («роли это флаги одной записи; на этом держится…»), и разбиение
 * по ней режет команду посередине — на этом уже падал первый прогон.
 */
export function statementsOf(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((piece) => piece.trim().replace(/\n/g, ' ').replace(/\s+/g, ' '))
    .filter(Boolean);
}

/** То же, но из файла. */
export function statementsOfFile(path) {
  return statementsOf(readFileSync(path, 'utf8'));
}
