export const label = 'how · status quo';
export const fragments = 0;

/* Four practices, one line each. The fourth is the one that sets up slide 5. */
const practices = [
  {
    name: 'BVT in production',
    line: 'Smoke tests after release. Expensive, error-prone, thin coverage.',
  },
  {
    name: 'Programmatic tests',
    line: 'Written from the developer’s seat. You are not the user.',
  },
  {
    name: 'Live user testing',
    line: 'Pilots and canaries. Low volume, expensive, risky.',
  },
  {
    name: 'Acceptance criteria',
    line: 'QA was the chain of custody. We fired the testers and never replaced them.',
    accent: true,
  },
];

export default function StatusQuo() {
  return (
    <div>
      <h2 className="headline" style={{ fontSize: 38, marginBottom: 46 }}>
        Four ways we answer it today.
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          columnGap: 76,
          rowGap: 46,
        }}
      >
        {practices.map((p) => (
          <div
            key={p.name}
            style={{
              paddingLeft: 22,
              borderLeft: `2px solid ${p.accent ? 'var(--flag)' : 'var(--line)'}`,
            }}
          >
            <p
              className="mono"
              style={{
                margin: '0 0 12px',
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: p.accent ? 'var(--flag)' : 'var(--mute)',
              }}
            >
              {p.name}
            </p>
            <p className="line" style={{ fontSize: 26, maxWidth: 460 }}>
              {p.line}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export const notes = `Walk each one quickly.

BVT — basic smoke tests, run in production after release. Expensive, error-prone, low coverage.
PROGRAMMATIC TESTS — who wrote them? Not a human, and not from the user's perspective. "You are not the user."
LIVE USER TESTING — pilots, canaries. Low volume, expensive, risky.

Land the last one hardest: acceptance criteria used to be OWNED. A tester signed off that the built thing matched the agreed thing. That hand-off chain is gone and nothing replaced it.

(This sets up slide 5, where the story BECOMES the AC.)`;
