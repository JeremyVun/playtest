import Reveal from '../components/Reveal.jsx';

export const label = 'the story';
export const fragments = 4;

/* The slide is the config surface itself: a story YAML building one concept
   at a time, with the concept named in the margin. The YAML shape mirrors a
   real suite story (tests/fixtures/todos/stories/add-todo.yaml). */

const Y = {
  key: { color: 'var(--pass)' },
  str: { color: 'var(--chalk)' },
  dim: { color: 'var(--mute)' },
};

function Chunk({ at, term, star, children }) {
  return (
    <Reveal at={at}>
      <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', columnGap: 40 }}>
        <span className="b" style={{ fontSize: 34, letterSpacing: '-0.02em', textAlign: 'right' }}>
          {term}
          {star ? <span className="flag">*</span> : null}
        </span>
        <pre
          className="mono"
          style={{ margin: 0, fontSize: 21, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}
        >
          {children}
        </pre>
      </div>
    </Reveal>
  );
}

export default function Story() {
  return (
    <div>
      <h2 className="headline" style={{ fontSize: 38, marginBottom: 44 }}>
        Paved roads in a world of slop.
      </h2>
      <div
        style={{
          display: 'grid',
          rowGap: 22,
          borderLeft: '2px solid var(--line)',
          paddingLeft: 0,
        }}
      >
        <Chunk at={1} term="Persona">
          <span style={Y.key}>story:</span> <span style={Y.dim}>|</span>
          {'\n  '}
          <span style={Y.str}>You keep forgetting to buy milk on the way home.</span>
        </Chunk>

        <Chunk at={2} term="Goal">
          {'  '}
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

        <Chunk at={4} term="Target" star>
          <span style={Y.key}>app:</span>
          {'\n  '}
          <span style={Y.dim}>driver:</span> <span style={Y.str}>web</span>{' '}
          <span style={Y.dim}># web · mobile · api</span>
        </Chunk>
      </div>
    </div>
  );
}

export const notes = `A Playtest story is a plain-language artifact — and this IS the file, not a diagram of it. Persona and goal are just prose in story:; assertions are the success: list (LLM asserts next to deterministic gates like api_called and console_errors); the target is the suite's driver.

THE PUNCHLINE for slide 3's AC row — the story IS the acceptance criterion. One-to-one between the AC and the executable test-case artifact. The chain of custody comes back, and it is written from the user's perspective by construction.

The asterisk on "api" is deliberate: we'll come back to that (slide 9).`;
