export default function NotFound() {
  return (
    <div className="wrap">
      <div className="empty" style={{ marginTop: 40 }}>
        <strong>Такого объекта в каталоге нет</strong>
        Возможно, он уже продан или снят с публикации: объект уходит из каталога
        в тот же момент, когда закрывается договор с собственником.{" "}
        <a className="reset" href="/">
          Вернуться в каталог
        </a>
      </div>
    </div>
  );
}
