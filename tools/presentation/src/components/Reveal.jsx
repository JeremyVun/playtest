import { createContext, useContext } from 'react';

/** Current fragment step of the active slide (0 = nothing revealed yet). */
export const StepContext = createContext(0);

export const useStep = () => useContext(StepContext);

/**
 * Progressive reveal. Wrap anything that should appear on a later key press:
 *
 *   <Reveal at={2}>…</Reveal>
 *
 * The slide module must export `fragments` equal to its highest `at`.
 */
export default function Reveal({ at = 1, className = '', style, children }) {
  const step = useStep();
  return (
    <div className={`reveal${step >= at ? ' on' : ''}${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </div>
  );
}
