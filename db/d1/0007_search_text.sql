-- Поиск по имени контакта и по тексту потребности — через нормализованную
-- колонку, как у адресов объектов.
--
-- Зачем. Запросы искали через `lower(c.name) like ?` и
-- `lower(requirements_text) like ?`, а `lower()` в SQLite работает ТОЛЬКО
-- с латиницей: проверено запросом к боевой базе, `lower('ОРОЗОВ Нурлан')`
-- возвращает строку как есть. То есть поиск по русскому имени был
-- РЕГИСТРОЗАВИСИМЫМ: «орозов» не находил «Орозов». Для адресов объектов
-- этот подвох был учтён ещё в 0001 (колонка `search_text`), а здесь
-- остался незамеченным.
--
-- Почему колонкой, а не сравнением в коде, как у поиска дубликатов: там
-- правило (инициалы) на SQL не выражается вовсе, а здесь нужен именно
-- SQL — отбор идёт вместе с постраничной выдачей и `count(*) over ()`.
-- Сравнение в коде отфильтровало бы только загруженную страницу, и
-- счётчик врал бы.
--
-- Заполняет код той же функцией searchText(), что и у объектов: там же
-- сведены кыргызские буквы к русским.
alter table contacts add column search_text text not null default '';
alter table requirements add column search_text text not null default '';

create index if not exists contacts_search_idx on contacts (search_text);
create index if not exists requirements_search_idx on requirements (search_text);
