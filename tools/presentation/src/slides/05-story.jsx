import Reveal from '../components/Reveal.jsx';

export const label = 'the story';
export const fragments = 4;

/* The story builds one part at a time — the parts of the artifact, not steps. */
const parts = [
  { term: 'Persona', line: 'who is doing this' },
  { term: 'Goal', line: 'what they are trying to get done' },
  { term: 'Assertions', line: 'what must be true along the way' },
  { term: 'Target', line: 'web, mobile, api', star: true },
];

export default function Story() {
  return (
    <div>
      <h2 className="headline" style={{ fontSize: 38, marginBottom: 52 }}>
        Paved roads in a world of slop.
      </h2>
      <div style={{ display: 'grid', rowGap: 26 }}>
        {parts.map((p, i) => (
          <Reveal key={p.term} at={i + 1}>
            <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', alignItems: 'baseline' }}>
              <span className="b" style={{ fontSize: 40, letterSpacing: '-0.02em' }}>
                {p.term}
              </span>
              <span className="line" style={{ fontSize: 32, color: 'var(--mute)' }}>
                {p.line}
                {p.star ? <span className="flag">*</span> : null}
              </span>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}

export const notes = `A Playtest story is a plain-language artifact: a persona with a goal, and assertions about what they must see and be able to do.

THE PUNCHLINE for slide 3's AC row — the story IS the acceptance criterion. One-to-one between the AC and the executable test-case artifact. The chain of custody comes back, and it is written from the user's perspective by construction.

The asterisk on "api" is deliberate: we'll come back to that (slide 9).`;
