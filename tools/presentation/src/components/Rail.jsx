/**
 * The trajectory rail: one segment per slide, read left to right like a
 * recorded run. The live segment fills as the slide's fragments are revealed.
 */
export default function Rail({ total, index, step, fragments }) {
  const fill = fragments > 0 ? ((step + 1) / (fragments + 1)) * 100 : 100;
  return (
    <div className="rail" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => {
        const state = i < index ? 'past' : i === index ? 'now' : 'ahead';
        return (
          <span
            key={i}
            className={`rail-seg ${state}`}
            style={state === 'now' ? { '--fill': `${fill}%` } : undefined}
          />
        );
      })}
    </div>
  );
}
