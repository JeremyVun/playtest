import Reveal from '../components/Reveal.jsx';

export const label = 'record · replay · heal';
export const fragments = 4;

/* Cost control and reproducibility in one figure: the same 12-step journey
   three times, drawn as a connected path (a journey, not loose dots).
   Green = model-driven step (paid). Ink = replayed step (executed, free).
   Replay is geometrically identical to Record — that sameness IS the
   reproducibility claim. Heal re-records only two steps, called out by a
   bracket right under them. */

const STEPS = 12;
const HEALED = [6, 7];
const DOT = 17;
const GAP = 10;

function Dot({ paid }) {
  return (
    <span
      style={{
        width: DOT,
        height: DOT,
        borderRadius: '50%',
        flex: 'none',
        background: paid ? 'var(--pass)' : 'var(--mute)',
        position: 'relative',
      }}
    />
  );
}

/* A connected path of steps; `paid` is 'all', 'none', or the healed pair. */
function Path({ paid, annotate }) {
  const isPaid = (i) => (paid === 'all' ? true : paid === 'none' ? false : HEALED.includes(i));
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: GAP }}>
      <span
        style={{
          position: 'absolute',
          left: DOT / 2,
          right: DOT / 2,
          top: '50%',
          height: 2,
          marginTop: -1,
          background: paid === 'all' ? 'var(--pass)' : 'var(--mute)',
          opacity: 0.55,
        }}
      />
      {Array.from({ length: STEPS }, (_, i) => (
        <Dot key={i} paid={isPaid(i)} />
      ))}
      {annotate ? (
        <span
          style={{
            position: 'absolute',
            left: HEALED[0] * (DOT + GAP) - 4,
            width: 2 * DOT + GAP + 8,
            top: DOT + 5,
            textAlign: 'center',
          }}
        >
          <span
            style={{
              display: 'block',
              height: 6,
              borderLeft: '2px solid var(--pass)',
              borderRight: '2px solid var(--pass)',
              borderBottom: '2px solid var(--pass)',
            }}
          />
          <span
            className="mono"
            style={{
              display: 'block',
              marginTop: 5,
              fontSize: 13,
              letterSpacing: '0.06em',
              color: 'var(--pass)',
              whiteSpace: 'nowrap',
            }}
          >
            app changed → re-recorded
          </span>
        </span>
      ) : null}
    </div>
  );
}

function Row({ at, term, caption, cost, paid, annotate }) {
  return (
    <Reveal at={at}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '210px 1fr 110px',
          columnGap: 36,
          alignItems: 'first baseline',
        }}
      >
        <span className="b" style={{ fontSize: 34, letterSpacing: '-0.02em', textAlign: 'right' }}>
          {term}
        </span>
        <div>
          <Path paid={paid} annotate={annotate} />
          <p className="sub" style={{ marginTop: annotate ? 40 : 10, fontSize: 18 }}>{caption}</p>
        </div>
        <span className="mono" style={{ fontSize: 22, textAlign: 'right', color: 'var(--mute)' }}>
          {cost}
        </span>
      </div>
    </Reveal>
  );
}

function LegendDot({ color }) {
  return (
    <span
      style={{
        width: 11,
        height: 11,
        borderRadius: '50%',
        display: 'inline-block',
        background: color,
        marginRight: 7,
        verticalAlign: 'baseline',
      }}
    />
  );
}

export default function Replay() {
  return (
    <div>
      <h2 className="headline" style={{ fontSize: 38, marginBottom: 10 }}>
        Every run is a recording.
      </h2>
      <p className="mono" style={{ margin: '0 0 38px', fontSize: 14, letterSpacing: '0.06em', color: 'var(--mute)' }}>
        <LegendDot color="var(--pass)" />
        model-driven step — costs money&ensp;·&ensp;
        <LegendDot color="var(--mute)" />
        replayed step — free
      </p>
      <div style={{ display: 'grid', rowGap: 30 }}>
        <Row
          at={1}
          term="Record"
          caption="the actor explores the journey once — every step is saved"
          cost="$0.25"
          paid="all"
        />
        <Row
          at={2}
          term="Replay"
          caption="the exact same path, step for step — no model calls"
          cost="$0.00"
          paid="none"
        />
        <Row
          at={3}
          term="Heal"
          caption="two steps drifted — only they re-engage the model"
          cost="$0.04"
          paid="healed"
          annotate
        />
      </div>
      <Reveal at={4} style={{ marginTop: 40 }}>
        <p className="line" style={{ fontSize: 34 }}>
          <span className="b">25¢</span> to record. <span className="b">Free</span> to replay.{' '}
          <span className="b">Heals only what breaks.</span>
        </p>
        <p className="sub" style={{ marginTop: 10 }}>
          And the same path every run — reproducible by construction.
        </p>
      </Reveal>
    </div>
  );
}

export const notes = `Cost control and reproducibility — the two things everyone is asking of AI tooling right now — come from the same mechanism.

Read the figure: each row is the SAME 12-step journey. Green steps cost money (a model chose them); ink steps are free (replayed from the recording).

RECORD — the first green run is saved as the case's baseline path (~25¢ of model usage for a typical journey).
REPLAY — visually identical to the row above, and that's the point: the exact same path re-runs deterministically, no model calls, $0. Sameness is what makes runs comparable and CI-gateable.
HEAL — the app changed under two steps; the bracket marks them. Only those two re-engage the model, then the repaired path is saved. Pennies, proportional to drift.

Punchline: pay to explore once; pay for drift; never pay for repetition. Segue from slide 6's footnote ("later laps cost less") and sets up the demo — the checked replays you're about to see live.`;
