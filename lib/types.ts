// Формы строк представлений кабинета (миграция 0008).
//
// Поля контактов объявлены как `string | null` не для удобства, а по сути:
// представления присоединяют контакты через LEFT JOIN, и агент, которому
// контакт по инварианту 4 не положен, получает здесь null. UI обязан это
// показывать как «контакт скрыт», а не как пустое место.

export type MatchStatus =
  | 'proposed' | 'interested' | 'showing_scheduled'
  | 'showing_done' | 'bargaining' | 'rejected' | 'in_deal';

export type DealType = 'rent' | 'sale';

export type ObjectMatch = {
  match_id: string;
  object_id: string;
  requirement_id: string;
  match_status: MatchStatus;
  showing_at: string | null;
  rejection_reason: string | null;
  closing_agent_name: string | null;
  deal_type: DealType;
  budget_min: number | null;
  budget_max: number | null;
  zones: string[];
  rooms_wanted: number[];
  requirement_status: string;
  client_name: string | null;   // null — контакт закрыт инвариантом 4
  commission_total: number | null;
  listing_share: number | null;
  closing_share: number | null;
  deal_id: string | null;
  deal_status: string | null;
};

export type RequirementMatch = {
  match_id: string;
  requirement_id: string;
  object_id: string;
  match_status: MatchStatus;
  showing_at: string | null;
  rejection_reason: string | null;
  address: string;
  zone: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  price: number;
  currency: string;
  publication_state: string;
  actual_at: string;
  mandate_id: string | null;
  contract_confirmed: boolean | null;
  listing_agent_name: string | null;
  owner_name: string | null;    // null — контакт закрыт инвариантом 4
  commission_total: number | null;
  listing_share: number | null;
  closing_share: number | null;
  deal_id: string | null;
  deal_status: string | null;
};

export const MATCH_STATUS_RU: Record<MatchStatus, string> = {
  proposed: 'предложен',
  interested: 'интересно',
  showing_scheduled: 'показ назначен',
  showing_done: 'показ состоялся',
  bargaining: 'торг',
  rejected: 'отказ',
  in_deal: 'в сделке',
};
