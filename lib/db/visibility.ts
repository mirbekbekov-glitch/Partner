import 'server-only';

/**
 * Предикаты видимости — один на весь кабинет.
 *
 * В Postgres их держала RLS: даже забудь страница условие, политика не
 * отдала бы чужую строку. В D1 политик нет, поэтому условие обязано стоять
 * ВНУТРИ каждого запроса — и здесь оно записано один раз, чтобы его нельзя
 * было забыть в одном месте из двадцати.
 *
 * СОГЛАШЕНИЕ О ПАРАМЕТРАХ, без которого это не работает:
 *
 *   ?1 — ВСЕГДА идентификатор текущего агента,
 *   ?2 и дальше — всё остальное.
 *
 * Поэтому предикат админа — не «1 = 1», а «?1 = ?1»: он всё равно обязан
 * упомянуть ?1. Иначе у админа в запросе не остаётся ни одной подстановки,
 * значение всё равно передаётся, и D1 отвечает «Wrong number of parameter
 * bindings». На этом прогон и упал.
 *
 * Нумерованные параметры, а не позиционные «?», потому что предикат
 * вставляется в запрос в разных местах и по нескольку раз: внутри него
 * агент упоминается трижды, и считать позиции вручную — верный способ
 * однажды подставить чужое значение в условие доступа.
 */

export type Predicate = { sql: string; params: (string | number)[] };

/**
 * Контакт виден: тому, кто его привёл; участникам активной сделки, где он
 * собственник объекта или клиент; админу.
 *
 * Это инвариант 4 целиком. Сужать его нельзя — отберём доступ у участника
 * идущей сделки; расширять — сломаем сам инвариант.
 *
 * `alias` — имя таблицы контактов в запросе, куда предикат вставляется.
 */
export function contactVisible(
  alias: string,
  agentId: string,
  admin: boolean,
): Predicate {
  if (admin) return { sql: '?1 = ?1', params: [agentId] };

  return {
    sql: `(
      ${alias}.owner_agent_id = ?1
      or exists (select 1
                   from deals d
                   join object_ownerships oo on oo.object_id = d.object_id
                  where oo.contact_id = ${alias}.id
                    and d.status not in ('closed', 'failed')
                    and ?1 in (d.listing_agent_id, d.closing_agent_id))
      or exists (select 1
                   from deals d
                   join requirements r on r.id = d.requirement_id
                  where r.contact_id = ${alias}.id
                    and d.status not in ('closed', 'failed')
                    and ?1 in (d.listing_agent_id, d.closing_agent_id))
    )`,
    params: [agentId],
  };
}

/**
 * Объект можно править: тому, кто его завёл; listing-агенту активного
 * мандата; админу.
 *
 * Тот же предикат отвечает за публикацию, снятие, подтверждение
 * актуальности и доступ к телефонам заявителей по объекту. Иначе вышло бы,
 * что снять объект с публикации агент может, а читать заявки по нему нет.
 */
export function objectEditable(
  alias: string,
  agentId: string,
  admin: boolean,
): Predicate {
  if (admin) return { sql: '?1 = ?1', params: [agentId] };

  return {
    sql: `(
      ${alias}.created_by_agent_id = ?1
      or exists (select 1 from mandates m
                  where m.object_id = ${alias}.id
                    and m.status = 'active'
                    and m.listing_agent_id = ?1)
    )`,
    params: [agentId],
  };
}

/**
 * Участник сделки: listing-агент, closing-агент, админ.
 *
 * Сделку видят только её стороны. Это не то же, что «вести подбор»:
 * предложить объект чужому клиенту можно, участвовать в чужой сделке — нет.
 */
export function dealParty(
  alias: string,
  agentId: string,
  admin: boolean,
): Predicate {
  if (admin) return { sql: '?1 = ?1', params: [agentId] };

  return {
    sql: `?1 in (${alias}.listing_agent_id, ${alias}.closing_agent_id)`,
    params: [agentId],
  };
}
