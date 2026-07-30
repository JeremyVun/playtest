import Reveal from '../components/Reveal.jsx';

export const label = 'why';
export const fragments = 1;

export default function Asymmetry() {
  return (
    <div>
      {/* The cheap thing is set light; the expensive thing is set heavy.
          Line breaks are deliberate — both blocks land on a short line. */}
      <p className="statement thin" style={{ color: 'var(--mute)' }}>
        Generating product code with AI
        <br />
        is now cheap.
      </p>
      <Reveal at={1} style={{ marginTop: 30 }}>
        <p className="statement b">
          Verification and attestation
          <br />
          is not.
        </p>
      </Reveal>
    </div>
  );
}

export const notes = `The cost of PRODUCING code has collapsed. The cost of KNOWING it works — and being able to show someone that it works — has not moved.

That asymmetry is the gap this product sits in: as generation gets cheaper, unverified surface area grows, and verification becomes both the bottleneck and the value.

(Slide 10 calls back to this line with a concrete instance.)`;
