import { MAX_UPLOAD_BYTES } from "../../lib/photos";
import { ActionForm } from "./ActionForm";
import { deletePhoto, movePhoto, setCover, uploadPhotos } from "./actions";

/**
 * Фотографии объекта в кабинете.
 *
 * Обложка — это первая фотография, а не отдельный флаг, поэтому «сделать
 * обложкой» и «подвинуть» — одно и то же действие с разным шагом. Так
 * устроено в базе, и экран не выдумывает другой модели.
 *
 * Отдаются фотографии через `/cabinet/photo/…`, а не через публичный адрес:
 * до публикации объекта публичная ссылка на них не работает по инварианту 11,
 * и правильно, что не работает.
 */
export function Photos({
  objectId,
  photos,
  canEdit,
  limit,
  whyNot,
}: {
  objectId: string;
  photos: {
    storage_key: string;
    sort_order: number;
    width: number | null;
    height: number | null;
    byte_size: number | null;
    is_cover: boolean;
  }[];
  canEdit: boolean;
  limit: number;
  /** Почему править нельзя. Пустой экран без причины выглядит как поломка. */
  whyNot?: string;
}) {
  const left = limit - photos.length;

  return (
    <section>
      <h2>
        Фотографии <span className="muted">({photos.length} из {limit})</span>
      </h2>

      {photos.length === 0 ? (
        <p className="empty">
          Фотографий нет. Объект без фотографий публикуется, но в каталоге его
          листают мимо.
        </p>
      ) : (
        <ol className="gallery">
          {photos.map((p, i) => (
            <li key={p.storage_key} className={p.is_cover ? "shot cover" : "shot"}>
              <img
                src={`/cabinet/photo/${p.storage_key}`}
                alt={p.is_cover ? "Обложка объекта" : `Фотография ${i + 1}`}
                width={p.width ?? undefined}
                height={p.height ?? undefined}
                loading="lazy"
              />
              <div className="shot-foot">
                <span className="muted small">
                  {p.is_cover ? "обложка" : `${i + 1}`}
                  {p.width && p.height ? ` · ${p.width}×${p.height}` : ""}
                  {p.byte_size ? ` · ${Math.round(p.byte_size / 1024)} КБ` : ""}
                </span>

                {canEdit && (
                  <div className="shot-acts">
                    {!p.is_cover && (
                      <ActionForm action={setCover} label="На обложку" className="act tight">
                        <input type="hidden" name="object_id" value={objectId} />
                        <input type="hidden" name="storage_key" value={p.storage_key} />
                      </ActionForm>
                    )}
                    {i > 0 && (
                      <ActionForm action={movePhoto} label="←" className="act tight">
                        <input type="hidden" name="object_id" value={objectId} />
                        <input type="hidden" name="storage_key" value={p.storage_key} />
                        <input type="hidden" name="direction" value="up" />
                      </ActionForm>
                    )}
                    {i < photos.length - 1 && (
                      <ActionForm action={movePhoto} label="→" className="act tight">
                        <input type="hidden" name="object_id" value={objectId} />
                        <input type="hidden" name="storage_key" value={p.storage_key} />
                        <input type="hidden" name="direction" value="down" />
                      </ActionForm>
                    )}
                    <ActionForm
                      action={deletePhoto}
                      label="Удалить"
                      className="act tight"
                      danger
                      confirm="Удалить фотографию? Файл будет убран из хранилища, вернуть его нельзя."
                    >
                      <input type="hidden" name="object_id" value={objectId} />
                      <input type="hidden" name="storage_key" value={p.storage_key} />
                    </ActionForm>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {canEdit && left > 0 && (
        <div className="card">
          <h3>Добавить фотографии</h3>
          <ActionForm action={uploadPhotos} label="Загрузить">
            <input type="hidden" name="object_id" value={objectId} />
            <input
              type="file"
              name="photos"
              accept="image/jpeg,image/png,image/webp"
              multiple
              required
            />
          </ActionForm>
          <p className="hint">
            Можно выбрать сразу несколько, осталось место для {left}. Каждый
            снимок до {MAX_UPLOAD_BYTES / 1024 / 1024} МБ — его всё равно
            сожмём: в хранилище попадает не присланный файл, а созданный нами
            заново. Поэтому координаты съёмки из снимка не уедут в каталог, а
            объявление не будет грузиться по десять секунд.
          </p>
        </div>
      )}

      {!canEdit && whyNot && <p className="warn-banner">{whyNot}</p>}

      {canEdit && left <= 0 && (
        <p className="warn-banner">
          Больше {limit} фотографий на объект не бывает. Удалите лишние, если
          нужно добавить новые.
        </p>
      )}

      {photos.length > 0 && (
        <p className="muted">
          Публично фотографии видны ровно пока объект опубликован: байты отдаёт
          приложение, и право на файл проверяется в базе на каждый запрос.
        </p>
      )}
    </section>
  );
}
