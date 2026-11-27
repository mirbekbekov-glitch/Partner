import 'server-only';

/**
 * Отказы слоя доступа.
 *
 * В Postgres отказ приходил исключением с кодом 42501, и страницы разбирали
 * текст ошибки. Теперь отказ — это класс: его видно по типу, а не по
 * подстроке в сообщении. Сообщение остаётся человеческим, потому что его
 * показывают агенту.
 */

/** Нет права на действие. Соответствует прежнему «FORBIDDEN: …». */
export class Forbidden extends Error {
  readonly code = 'FORBIDDEN' as const;
  constructor(message = 'Недостаточно прав') {
    super(message);
    this.name = 'Forbidden';
  }
}

/** Запись не найдена — или найдена, но показывать её этому агенту нельзя.
 *
 * Эти два случая НАМЕРЕННО неразличимы снаружи: иначе существование чужой
 * записи выясняется перебором идентификаторов. */
export class NotFound extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor(message = 'Запись не найдена') {
    super(message);
    this.name = 'NotFound';
  }
}

/** Данные не проходят проверку: пустое имя, цена ноль, срок в прошлом. */
export class Invalid extends Error {
  readonly code = 'INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'Invalid';
  }
}

/** Действие ломает инвариант: публикация без мандата, сделка без подбора. */
export class Conflict extends Error {
  readonly code = 'CONFLICT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'Conflict';
  }
}

/**
 * Бюджет ниже рынка: по такой цене в этом срезе нет ни одного объявления.
 *
 * Отдельный класс, а не Invalid с текстом, потому что форме нужны ЧИСЛА:
 * она показывает порог, число объявлений и кнопку «подставить». Разбирать
 * их обратно из фразы значило бы писать разборщик собственных сообщений —
 * и он сломается при первом переводе на другой язык.
 *
 * Наследует Invalid: для всего, что просто показывает ошибку, это обычная
 * непрошедшая проверка, и ни один вызывающий не обязан знать про порог.
 */
export class BudgetTooLow extends Invalid {
  constructor(
    readonly floor: number,
    readonly currency: string,
    readonly basedOn: number,
  ) {
    super(`В этом районе дешевле ${floor} нет ни одного варианта`);
    this.name = 'BudgetTooLow';
  }
}

/** Ошибка слоя доступа, которую можно показать человеку как есть. */
export type DbError = Forbidden | NotFound | Invalid | Conflict;

export function isDbError(e: unknown): e is DbError {
  return e instanceof Forbidden || e instanceof NotFound
      || e instanceof Invalid || e instanceof Conflict;
}
