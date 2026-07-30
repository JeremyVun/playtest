/** Presenter notes. Hidden by default; `n` toggles, `Escape` closes. */
export default function Notes({ label, index, total, notes, onClose }) {
  return (
    <aside className="notes" data-no-advance onClick={(event) => event.stopPropagation()}>
      <div className="notes-head">
        <span className="eyebrow">
          Notes · {String(index + 1).padStart(2, '0')}/{String(total).padStart(2, '0')} · {label}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <span className="eyebrow hint">← → move · home / end · f fullscreen</span>
          <button type="button" className="btn" onClick={onClose}>
            Hide (n)
          </button>
        </span>
      </div>
      <div className="notes-body">{notes?.trim() || 'No notes for this slide.'}</div>
    </aside>
  );
}
