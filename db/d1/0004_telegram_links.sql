-- Привязка Telegram агентом самостоятельно.
--
-- Раньше telegram_id проставлял только админ: агент присылал ему номер,
-- тот вписывал. Это и лишняя работа для двоих, и дыра — админ верит, что
-- номер принадлежит тому, кто его прислал, и проверить это нечем.
--
-- Теперь агент получает одноразовый код, открывает бота по ссылке, бот
-- видит НАСТОЯЩИЙ идентификатор отправителя и привязывает его. Подделать
-- нельзя: идентификатор приходит от Telegram, а не от человека.
--
-- Устройство то же, что у входа по почте: в базе лежит только SHA-256 от
-- кода, сам код существует ровно в одной ссылке.
create table if not exists telegram_links (
  code_hash  text primary key,
  agent_id   text not null references agents (id) on delete cascade,
  created_at text not null,
  expires_at text not null,
  -- Одноразовость: повтор — отказ, а не вторая привязка.
  used_at    text
);

create index if not exists telegram_links_agent_idx   on telegram_links (agent_id);
create index if not exists telegram_links_expires_idx on telegram_links (expires_at);
