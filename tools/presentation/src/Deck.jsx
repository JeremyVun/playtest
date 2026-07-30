import { useCallback, useEffect, useMemo, useState } from 'react';
import { slides } from './slides/index.js';
import { StepContext } from './components/Reveal.jsx';
import Notes from './components/Notes.jsx';
import Rail from './components/Rail.jsx';

const STAGE_W = 1280;
const STAGE_H = 720;

/** Number of reveal beats on a slide (0 = the whole slide shows at once). */
const fragmentsOf = (slide) => slide.fragments ?? 0;
const clamp = (i) => Math.max(0, Math.min(slides.length - 1, i));

export default function Deck() {
  // One piece of state so every transition is a single pure update.
  const [pos, setPos] = useState({ index: 0, step: 0, back: false });
  const [notesOpen, setNotesOpen] = useState(false);
  const [scale, setScale] = useState(1);
  // The control hint shows on the opening slide until the presenter touches it.
  const [touched, setTouched] = useState(false);

  const { index, step, back } = pos;
  const slide = slides[index];
  const total = slides.length;

  useEffect(() => {
    const fit = () =>
      setScale(Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  const goTo = useCallback(
    (next, atEnd = false) =>
      setPos((p) => {
        const i = clamp(next);
        return { index: i, step: atEnd ? fragmentsOf(slides[i]) : 0, back: i < p.index };
      }),
    [],
  );

  const advance = useCallback(
    () =>
      setPos((p) => {
        if (p.step < fragmentsOf(slides[p.index])) return { ...p, step: p.step + 1 };
        if (p.index < slides.length - 1) return { index: p.index + 1, step: 0, back: false };
        return p;
      }),
    [],
  );

  const retreat = useCallback(
    () =>
      setPos((p) => {
        if (p.step > 0) return { ...p, step: p.step - 1 };
        if (p.index > 0) {
          const i = p.index - 1;
          return { index: i, step: fragmentsOf(slides[i]), back: true };
        }
        return p;
      }),
    [],
  );

  useEffect(() => {
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      setTouched(true);
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case ' ':
        case 'PageDown':
        case 'Enter':
          event.preventDefault();
          advance();
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          event.preventDefault();
          retreat();
          break;
        case 'Home':
          event.preventDefault();
          goTo(0);
          break;
        case 'End':
          event.preventDefault();
          goTo(slides.length - 1, true);
          break;
        case 'n':
        case 'N':
          event.preventDefault();
          setNotesOpen((open) => !open);
          break;
        case 'Escape':
          setNotesOpen(false);
          break;
        case 'f':
        case 'F':
          event.preventDefault();
          if (document.fullscreenElement) document.exitFullscreen();
          else document.documentElement.requestFullscreen?.();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, retreat, goTo]);

  const onClick = useCallback(
    (event) => {
      // Anything interactive on a slide opts out of click-to-advance.
      if (event.target.closest?.('[data-no-advance]')) return;
      advance();
    },
    [advance],
  );

  const Slide = slide.default;
  const stageStyle = useMemo(() => ({ '--k': scale }), [scale]);

  return (
    <div className="viewport" onClick={onClick}>
      <div className="stage" style={stageStyle}>
        <header className="chrome-top">
          <span className="eyebrow">
            <span className="tick">▍</span> {slide.label}
          </span>
          <span className="counter">
            <b>{String(index + 1).padStart(2, '0')}</b> / {String(total).padStart(2, '0')}
          </span>
        </header>

        <main className={`slide slide-anim${back ? ' back' : ''}`} key={index}>
          <StepContext.Provider value={step}>
            <Slide active step={step} />
          </StepContext.Provider>
        </main>

        <footer className="chrome-bottom">
          <Rail total={total} index={index} step={step} fragments={fragmentsOf(slide)} />
          <div className="wordmark">
            <span>Playtest · does it work?</span>
            {index === 0 && !touched ? (
              <span className="hint">← → move · n notes · f fullscreen</span>
            ) : null}
          </div>
        </footer>
      </div>

      {notesOpen ? (
        <Notes
          label={slide.label}
          index={index}
          total={total}
          notes={slide.notes}
          onClose={() => setNotesOpen(false)}
        />
      ) : null}
    </div>
  );
}
