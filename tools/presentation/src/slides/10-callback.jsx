import Reveal from '../components/Reveal.jsx';

export const label = 'wrap-up';
export const fragments = 1;

export default function Callback() {
  return (
    <div>
      {/* Same device as slide 2: the cheap thing light, the expensive thing heavy. */}
      <p className="statement thin" style={{ color: 'var(--mute)' }}>
        Generating the app
        <br />
        took an afternoon.
      </p>
      <Reveal at={1} style={{ marginTop: 30 }}>
        <p className="statement b">
          Proving anything about it
          <br />
          took a study.
        </p>
      </Reveal>
    </div>
  );
}

export const notes = `Callback to slide 2, now with a concrete instance the audience has just seen: the study's subject app — 20 seeded bugs, stories, catalog — was AI-generated in an afternoon. The pre-registered study needed to ATTEST anything about it took two trials over two days. That is the asymmetry, lived.

The resolution: we paid the expensive attestation cost ONCE. The studies are what license trusting the instrument, so per-release verification becomes cheap and repeatable — a full three-round bug hunt for about $22, and in steady state 25¢ to record a journey, free to replay, healing paid only when things drift.

FINAL SPOKEN LINE (the slide-1 bookend — delivered, not shown):
"So — does it work? You can now ask that question of every story, on every release, and get an answer with evidence attached."`;
