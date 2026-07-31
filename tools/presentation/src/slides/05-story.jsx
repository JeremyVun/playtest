import Reveal from '../components/Reveal.jsx';

export const label = 'the story';
export const fragments = 4;

/* The slide is the config surface itself, built one concept at a time across
   the three real files: a persona (personas/<slug>.yaml, prose description),
   a story case (stories/<name>.yaml), and the suite playtest.yaml that wires
   them together. Shapes mirror tests/fixtures and studies/hosted-ux. */

const Y = {
  key: { color: 'var(--pass)' },
  str: { color: 'var(--chalk)' },
  dim: { color: 'var(--mute)' },
};

function File({ name }) {
  return (
    <div className="mono" style={{ fontSize: 14, color: 'var(--mute)', letterSpacing: '0.08em', marginBottom: 6 }}>
      {name}
    </div>
  );
}

function Chunk({ at, term, star, file, children }) {
  return (
    <Reveal at={at}>
      <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', columnGap: 40 }}>
        <span className="b" style={{ fontSize: 34, letterSpacing: '-0.02em', textAlign: 'right' }}>
          {term}
          {star ? <span className="flag">*</span> : null}
        </span>
        <div>
          {file ? <File name={file} /> : null}
          <pre
            className="mono"
            style={{ margin: 0, fontSize: 20, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}
          >
            {children}
          </pre>
        </div>
      </div>
    </Reveal>
  );
}

export default function Story() {
  return (
    <div>
      <h2 className="headline" style={{ fontSize: 38, marginBottom: 38 }}>
        Paved roads in a world of slop.
      </h2>
      <div style={{ display: 'grid', rowGap: 20, borderLeft: '2px solid var(--line)' }}>
        <Chunk at={1} term="Persona" file="personas/busy-parent.yaml">
          <span style={Y.key}>description:</span> <span style={Y.dim}>|</span>
          {'\n  '}
          <span style={Y.str}>You're a busy parent who lives out of reminder lists.</span>
        </Chunk>

        <Chunk at={2} term="Goal" file="stories/add-todo.yaml">
          <span style={Y.key}>story:</span> <span style={Y.dim}>|</span>
          {'\n  '}
          <span style={Y.str}>Add a todo called "buy milk" so it shows up in your list.</span>
        </Chunk>

        <Chunk at={3} term="Assertions">
          <span style={Y.key}>success:</span>
          {'\n  '}
          <span style={Y.dim}>- assert:</span>{' '}
          <span style={Y.str}>the list shows a todo called "buy milk"</span>
          {'\n  '}
          <span style={Y.dim}>- api_called:</span> <span style={Y.str}>"POST /api/todos"</span>
          {'\n  '}
          <span style={Y.dim}>- console_errors:</span> <span style={Y.str}>0</span>
        </Chunk>

        <Chunk at={4} term="Target" star file="playtest.yaml">
          <span style={Y.key}>persona:</span> <span style={Y.str}>busy-parent</span>
          {'\n'}
          <span style={Y.key}>app:</span>
          {'\n  '}
          <span style={Y.dim}>driver:</span> <span style={Y.str}>web</span>{' '}
          <span style={Y.dim}># web · mobile · api</span>
        </Chunk>
      </div>
    </div>
  );
}

export const notes = `The config surface is three small files, and this slide IS them, not a diagram of them.

PERSONA — its own file (personas/<slug>.yaml), prose describing who the user is. Reusable across stories.
GOAL + ASSERTIONS — the story case: plain-language story:, then success: mixing LLM asserts with deterministic gates (api_called, console_errors).
TARGET — playtest.yaml wires it together: persona by slug, driver picks the surface.

THE PUNCHLINE for slide 3's AC row — the story IS the acceptance criterion. One-to-one between the AC and the executable test-case artifact. The chain of custody comes back, written from the user's perspective by construction.

The asterisk on "api" is deliberate: we'll come back to that (slide 10).`;
