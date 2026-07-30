import Reveal from '../components/Reveal.jsx';

export const label = 'proof, not vibes · api';
export const fragments = 3;

export default function ApiStudy() {
  return (
    <div style={{ display: 'grid', rowGap: 26 }}>
      <p className="line" style={{ fontSize: 32 }}>
        The API layer sees what browsers can’t — 4 bugs no web arm ever found.
      </p>

      <Reveal at={1}>
        <p className="line" style={{ fontSize: 32 }}>
          Free fuzzing: triggered every bug, reported zero.
        </p>
      </Reveal>

      <Reveal at={2}>
        <p className="line" style={{ fontSize: 32 }}>
          A coding agent with the spec: 10/10, $11, 12 minutes.
        </p>
      </Reveal>

      <Reveal at={3} style={{ marginTop: 14 }}>
        <hr className="rule" style={{ marginBottom: 26 }} />
        <p className="headline" style={{ fontSize: 44 }}>
          No user → no user story.
          <br />
          <span className="thin" style={{ color: 'var(--mute)' }}>
            Playtest stops where the user does.
          </span>
        </p>
      </Reveal>
    </div>
  );
}

export const notes = `Same app, this time its JSON API — the 10 API-observable seeded faults, three black-box testers: a coding agent holding the OpenAPI spec, the Playtest probe, and Schemathesis as the free floor.

THE LAYERS ARE COMPLEMENTARY — the faults browser testing missed are exactly the ones API testing caught. API testing matters.

BUT FUZZING CAN'T DO IT — no oracle for "plausible but wrong". It hit the wrong total 55 times and said nothing.

AND THE RIGHT INTELLIGENT TOOL IS A CODING AGENT, NOT PLAYTEST — the agent swept the catalog. Playtest's entire advantage is the user's perspective: persona, goal, journey. An API has no user-facing component. Take that away and stories are just a worse way to write programmatic tests.

Supporting API testing properly would mean giving the product an execution workspace for authored test code — at which point we are reinventing Claude Code, badly. We looked at that road in July and closed it then too.

The product answer is not "one tool for everything". It is Playtest for every surface a user touches, and your coding agent for the ones they don't.

WHY THIS LANDS: it is a scope boundary drawn by our own published experiment, not a retreat. A vendor who tells you where NOT to use their product earns the claims on slide 8.`;
