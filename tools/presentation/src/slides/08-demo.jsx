import { useCallback, useEffect, useState } from 'react';

export const label = 'demo · live';
export const fragments = 0;

/** The locally running Playtest platform: `npm run hosted` at the repository root. */
export const TARGET = 'http://127.0.0.1:4177';

export default function Demo({ active }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="demo-bar">
        <span
          className="mono"
          style={{ fontSize: 13, letterSpacing: '0.14em', color: 'var(--mute)' }}
        >
          {TARGET}
        </span>
        <span data-no-advance>
          <a className="btn" href={TARGET} target="_blank" rel="noreferrer">
            Open in new tab ↗
          </a>
        </span>
      </div>

      <div className="demo-stage" data-no-advance>
        <Frame active={active} />
      </div>
    </div>
  );
}

/** Probes the platform, then mounts an iframe only if it answered. */
function Frame({ active }) {
  const [state, setState] = useState('checking');
  const [attempt, setAttempt] = useState(0);
  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    setState('checking');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    fetch(TARGET, { mode: 'no-cors', cache: 'no-store', signal: controller.signal })
      .then(() => live && setState('up'))
      .catch(() => live && setState('down'));
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, attempt]);

  if (state === 'up') {
    // Mounted only while this slide is on screen; the deck never preloads it.
    return <iframe className="demo-view" src={TARGET} title="Playtest platform" />;
  }

  return (
    <div className="demo-view demo-empty">
      <p className="eyebrow" style={{ marginBottom: 16 }}>
        {state === 'checking' ? 'Looking for the platform…' : 'The platform is not running'}
      </p>
      <p className="line" style={{ fontSize: 25, maxWidth: 640, marginBottom: 24 }}>
        Start it from the repository root with{' '}
        <span className="mono pass" style={{ fontSize: 21 }}>
          npm run hosted
        </span>
        , then reconnect.
      </p>
      <div style={{ display: 'flex', gap: 12 }}>
        <button type="button" className="btn" onClick={reconnect}>
          Reconnect
        </button>
        <a className="btn" href={TARGET} target="_blank" rel="noreferrer">
          Open in new tab ↗
        </a>
      </div>
    </div>
  );
}

export const notes = `RUN SHEET

1. Web suite — create a suite, "help me draft" to generate several stories, run it, live view, context representation.
2. Pre-recorded and checked runs — the regression/replay side, live. Slide 7 made the economics point; here the audience sees a checked replay actually run.
3. Findings — including real findings already caught in production systems.
4. Mobile — short: a suite and a pre-recorded run.
5. API* — no demo. Tease "one tool for everything?" and answer it on slide 10.

FALLBACK (a planned move, not an apology): pre-recorded checked runs are ready for web and mobile. If the live run flakes, switch to the replay — that IS a product beat: "this is exactly what a checked replay is for."`;
