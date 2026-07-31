import Reveal from '../components/Reveal.jsx';

export const label = 'record · replay · heal';
export const fragments = 4;

/* Cost control and reproducibility in one figure: the same 12-step journey
   three times. A filled dot is a model-driven step (costs money); a hollow
   dot is a deterministic replayed step (free). Heal refills only the two
   steps that drifted. */

const STEPS = 12;
const HEALED = [6, 7];

function Dots({ paid }) {
  return (
    <div style={{ display: 'flex', gap: 9 }}>
      {Array.from({ length: STEPS }, (_, i) => {
        const hot = paid === 'all' || (Array.isArray(paid) && paid.includes(i));
        return (
          <span
            key={i}
            style={{
              width: 17,
              height: 17,
              borderRadius: '50%',
              background: hot ? 'var(--pass)' : 'transparent',
              boxShadow: hot ? 'none' : 'inset 0 0 0 1.5px var(--dim)',
            }}
          />
        );
      })}
    </div>
  );
}

function Row({ at, term, caption, cost, paid }) {
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
          <Dots paid={paid} />
          <p className="sub" style={{ marginTop: 10, fontSize: 18 }}>{caption}</p>
        </div>
        <span className="mono" style={{ fontSize: 22, textAlign: 'right', color: 'var(--mute)' }}>
          {cost}
        </span>
      </div>
    </Reveal>
  );
}

export default function Replay() {
  return (
    <div>
      <h2 className="headline" style={{ fontSize: 38, marginBottom: 46 }}>
        Every run is a recording.
      </h2>
      <div style={{ display: 'grid', rowGap: 34 }}>
        <Row
          at={1}
          term="Record"
          caption="the actor explores once — every step is saved"
          cost="$0.25"
          paid="all"
        />
        <Row
          at={2}
          term="Replay"
          caption="the saved path re-runs deterministically — no model calls"
          cost="$0.00"
          paid={[]}
        />
        <Row
          at={3}
          term="Heal"
          caption="the app changed — only the drifted steps re-engage the model"
          cost="$0.04"
          paid={HEALED}
        />
      </div>
      <Reveal at={4} style={{ marginTop: 48 }}>
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

RECORD — the first green run is saved as the case's baseline path (~25¢ of model usage for a typical journey).
REPLAY — later runs re-execute that saved path deterministically: no model calls, $0, and the SAME path every time, which is what makes runs comparable and CI-gateable.
HEAL — when the app legitimately changes, the run does not re-record from scratch: only the steps that drifted re-engage the model, then the repaired path is saved again. You pay pennies proportional to drift.

Punchline: pay to explore once; pay for drift; never pay for repetition. Segue from slide 6's footnote ("later laps cost less") and sets up the demo — the checked replays you're about to see live.`;
