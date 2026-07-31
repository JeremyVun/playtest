export const label = 'over to you';
export const fragments = 0;

export default function Questions() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%' }}>
      <h1 className="mega" style={{ fontSize: 132 }}>
        Questions.
      </h1>
      <p className="sub" style={{ marginTop: 34, fontSize: 22 }}>
        Both studies are published in full, failed bars included.
      </p>
    </div>
  );
}

export const notes = `BACKUP FACTS — disclose if asked; don't lead with them.

PRE-REGISTERED BARS: B1 and B2 failed for both methods identically — neither cleared 40% recall; union 50%. Fair summary: the choice moves WHICH bugs you catch, the cost, and the wall time — not the count.

THE NOISE BAR (B3) failed every round. But almost nothing was fabricated, and about 40% of the "noise" is design-sense UX findings the defect bar could not credit: contrast, below-fold friction, discoverability. The bar measured defect precision; the product was also answering slide 1's OTHER question. The fix is to separate defect claims from observations in the feed.

"FIXED" in the web study means the fault was withdrawn from the next build. No real fixes were generated or verified.

API STUDY FAIRNESS: the probe got 7/10 and worked from story text alone while the agent held the OpenAPI spec. That is logged in the report itself, and a spec-wired probe would likely close some of the gap. It would not change the conclusion: where there is no user journey, story-driven testing has no structural advantage to offer, so the scope boundary stands regardless.`;
