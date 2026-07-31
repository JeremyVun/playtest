import Reveal from '../components/Reveal.jsx';

export const label = 'proof, not vibes · web';
export const fragments = 4;

/* Five lines, one per beat. Line 1 is on screen when the slide opens. */
const lines = [
  <>Same app, 20 seeded bugs: Playtest vs a coding agent with a browser.</>,
  <>
    Both found 8 — <span className="b">not the same 8.</span> Playtest caught the bugs that{' '}
    <span className="b">look</span> correct.
  </>,
  <>It also found bugs we didn’t plant.</>,
  <>Two independent trials, identical results. 35% cheaper. Converged by round 2.</>,
  <>The misses? Roads the stories never paved.</>,
];

export default function WebStudy() {
  return (
    <div>
      <div style={{ display: 'grid', rowGap: 18 }}>
        {lines.map((line, i) =>
          i === 0 ? (
            <p key={i} className="line" style={{ fontSize: 29 }}>
              {line}
            </p>
          ) : (
            <Reveal key={i} at={i}>
              <p className="line" style={{ fontSize: 29 }}>
                {line}
              </p>
            </Reveal>
          ),
        )}
      </div>

      <Reveal at={1} style={{ marginTop: 34 }}>
        <hr className="rule" style={{ marginBottom: 22 }} />
        <Disjoint />
      </Reveal>
    </div>
  );
}

/*
  The 20 seeded faults, one column each, straight from the published data:
  6 found by both arms, 2 only by Playtest, 2 only by the agent, 10 by neither —
  the same split in both trials.
*/
const BOTH = 6;
const PLAYTEST_ONLY = 2;
const AGENT_ONLY = 2;
const TOTAL = 20;

function Disjoint() {
  const cell = (i, arm) => {
    if (i < BOTH) return 'both';
    if (i < BOTH + PLAYTEST_ONLY) return arm === 'p' ? 'p' : 'off';
    if (i < BOTH + PLAYTEST_ONLY + AGENT_ONLY) return arm === 'c' ? 'c' : 'off';
    return 'off';
  };

  const row = (arm) => (
    <div className="dot-row">
      {Array.from({ length: TOTAL }, (_, i) => (
        <span key={i} className={`dot ${cell(i, arm)}`} />
      ))}
    </div>
  );

  return (
    <div className="figure">
      <div className="figure-rows">
        <span className="dot-key pass">Playtest</span>
        {row('p')}
        <span className="dot-key flag">Coding agent</span>
        {row('c')}
      </div>
      <p className="dot-legend">
        20 seeded faults · 6 found by both · 2 only Playtest · 2 only the agent · 10 missed by both
      </p>
    </div>
  );
}

export const notes = `SETUP (30 seconds): if we can detect, we can hill-climb — detection is what makes the slide-6 loop real. So we pre-registered success bars and tried to fail our own product. A rental app with 20 seeded bugs, Playtest vs a coding agent with a browser, same gpt-5.5 actor, 3 fix-and-retest rounds, arm-blind judge, frozen scoring, run twice. Some bars failed; we publish those too — a deck that shows its failed bars is the one worth trusting.

NOT THE SAME 8 — Playtest's unique finds were the arithmetic faults: plausible-but-wrong values, caught because gates pin spec numbers like $35.10. An agent sees a reasonable number and moves on. The agent's uniques were two interaction edges.

BUGS WE DIDN'T PLANT — 5 latent issues credited per trial (agent: 4). We accidentally shipped 3 real validation bugs in our own subject app, and both methods kept finding them.

IDENTICAL RESULTS — same fault sets, round by round, across both trials. Repeatable enough to gate CI. About $22.50 per trial vs about $35. Counterweight: roughly 2x the wall clock. Round 3 added zero for either method — two rounds is the recipe.

ROADS NEVER PAVED — of the 10 bugs neither found, 4 were never even reached. Misses concentrate off-road: empty states, boundaries, calendar edges. On the paved surfaces detection was strong and immediate. Widening coverage is story authoring, not a detector rebuild — callback to slide 5.`;
