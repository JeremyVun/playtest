import Reveal from '../components/Reveal.jsx';

export const label = 'aside';
export const fragments = 1;

export default function DontMakeMeClick() {
  return (
    <div>
      <h1 className="mega" style={{ fontSize: 122 }}>
        Don’t make me click.
      </h1>
      <Reveal at={1} style={{ marginTop: 54 }}>
        <p className="line" style={{ fontSize: 34, color: 'var(--mute)' }}>
          A dev’s definition of tested:{' '}
          <span className="b" style={{ color: 'var(--chalk)' }}>
            “it compiled.”
          </span>
        </p>
      </Reveal>
    </div>
  );
}

export const notes = `One beat, self-deprecating. Devs will do anything to avoid manually clicking through their own app — including shipping.

Which is fine. Clicking through the app is exactly the thing we should be delegating.

("Don't make me click" riffs on Krug's "Don't Make Me Think" — ties back to slide 1's design sense. "It compiled" lands second, as the technical-sense twin.)`;
