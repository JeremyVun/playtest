import Reveal, { useStep } from '../components/Reveal.jsx';

export const label = 'the loop';
export const fragments = 4;

/*
  The deck's one real diagram.

    beat 1  Actor → World
    beat 2  … → Judge
    beat 3  … → Build → back to World (the loop closes)
    beat 4  Story feeds BOTH the Actor and the Judge (the structural point)
    beat 5  the economics footnote

  Geometry is a fixed 1104 × 455 canvas; move a node by editing its x/y here.
*/

export default function Loop() {
  const step = useStep();
  const on = (at) => `g-reveal${step >= at ? ' on' : ''}`;

  return (
    <div>
      <svg
        className="loop"
        viewBox="0 0 1104 455"
        width="1104"
        height="455"
        role="img"
        aria-label="Story feeds the Actor and the Judge. The Actor acts on the World, which yields a trajectory to the Judge, whose findings feed the Build, which changes the World."
      >
        <defs>
          <marker
            id="tip"
            viewBox="0 0 12 9"
            refX="0"
            refY="4.5"
            markerWidth="12"
            markerHeight="9"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0 L12 4.5 L0 9 Z" fill="var(--dim)" />
          </marker>
          <marker
            id="tip-pass"
            viewBox="0 0 12 9"
            refX="0"
            refY="4.5"
            markerWidth="12"
            markerHeight="9"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0 L12 4.5 L0 9 Z" fill="var(--pass)" />
          </marker>
        </defs>

        {/* beat 1 — actor acts on world */}
        <g className={on(0)}>
          <rect className="node" x="60" y="175" width="190" height="76" />
          <text className="node-label" x="155" y="221">
            Actor
          </text>
          <rect className="node" x="457" y="175" width="190" height="76" />
          <text className="node-label" x="552" y="221">
            World
          </text>
          <path className="edge" d="M258 213 H445" markerEnd="url(#tip)" />
          <text className="edge-label" x="351" y="201">
            acts on
          </text>
        </g>

        {/* beat 2 — the trajectory reaches the judge */}
        <g className={on(1)}>
          <rect className="node" x="854" y="175" width="190" height="76" />
          <text className="node-label" x="949" y="211">
            Judge
          </text>
          <text className="node-sub" x="949" y="234">
            gates + grader
          </text>
          <path className="edge" d="M655 213 H842" markerEnd="url(#tip)" />
          <text className="edge-label" x="748" y="201">
            trajectory
          </text>
        </g>

        {/* beat 3 — findings feed the build, the build changes the world */}
        <g className={on(2)}>
          <rect className="node" x="457" y="350" width="190" height="76" />
          <text className="node-label" x="552" y="396">
            Build
          </text>
          <path className="edge" d="M949 259 V388 H659" markerEnd="url(#tip)" />
          <text className="edge-label" x="806" y="376">
            findings
          </text>
          <path className="edge" d="M552 342 V263" markerEnd="url(#tip)" />
          <text className="edge-label" x="568" y="308" textAnchor="start">
            changes
          </text>
        </g>

        {/* beat 4 — the same artifact drives the acting and the grading */}
        <g className={on(3)}>
          <rect className="node story" x="322" y="18" width="460" height="64" />
          <text className="node-label story-label" x="552" y="46">
            Story
          </text>
          <text className="node-sub" x="552" y="68">
            persona · goal · assertions
          </text>
          <path className="edge pass" d="M322 50 H175 Q155 50 155 70 V163" markerEnd="url(#tip-pass)" />
          <path className="edge pass" d="M782 50 H929 Q949 50 949 70 V163" markerEnd="url(#tip-pass)" />
        </g>
      </svg>

      <Reveal at={4} style={{ marginTop: 14 }}>
        <p className="sub" style={{ fontSize: 21 }}>
          Later laps cost less — recorded runs replay and heal only what drifted.
        </p>
      </Reveal>
    </div>
  );
}

export const notes = `The actor (persona + goal) acts on the world and produces a trajectory. The judge — deterministic gates plus an LLM grader — turns that trajectory into findings. Findings feed the build; the build changes the world; the loop closes.

THE ONE STRUCTURAL DETAIL worth the extra arrow: the story feeds BOTH the actor and the judge. The same artifact drives the acting AND the grading. That is what makes "the story is the AC" a mechanical fact rather than a slogan — and it is what separates this from "an agent wanders around and writes a report".

Optional second beat if asked: iterations get cheaper. Recorded runs replay and self-heal, so the regression pass never pays the full exploration cost again.`;
