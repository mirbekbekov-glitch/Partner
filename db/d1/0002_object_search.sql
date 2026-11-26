-- 0002_object_search.sql — колонка поиска у объектов.
--
-- Для новой базы она уже описана в 0001; этот файл нужен тем базам, которые
-- завелись раньше. ALTER в SQLite не умеет IF NOT EXISTS, поэтому повторный
-- прогон отвечает «duplicate column name» — применяющий скрипт эту ошибку
-- пропускает сознательно и только её.

alter table objects add column search_text text not null default '';
