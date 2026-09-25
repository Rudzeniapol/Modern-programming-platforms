// Плашка с сообщением об успехе или об ошибке.
// Ошибки валидации приходят с сервера полями error.fields — они показываются
// рядом с полями формы, а здесь остаётся общий текст.
export default function Notice({ notice, onClose }) {
  if (!notice) return null;

  return (
    <p className={`notice notice--${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      {onClose && (
        <button className="notice__close" type="button" onClick={onClose} aria-label="Закрыть сообщение">
          ×
        </button>
      )}
    </p>
  );
}
