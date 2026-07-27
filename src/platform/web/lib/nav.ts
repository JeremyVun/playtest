// Primary project navigation (hosted IA). P1 froze this to four items. Suites
// remains the project home, Review became contextual
// (no permanent entry), and Insights was removed. Personas is the one addition
// since: a persona is project-wide, reused by every suite, and the story editor's
// persona picker has to send people somewhere to make one — a surface nothing
// links to is a surface nobody finds. Kept DOM-free so the hermetic gate can
// assert the item set without a browser.
// Each item carries a 16×16 icon (inner SVG markup, stroke = currentColor):
// the rail can collapse to icons only, so every item needs a glyph that still
// says what it is. Plain strings keep this module DOM-free for the offline gate.
export const RAIL: WebDynamic = [
  // Suites is the project home and the only suite index.
  { nav: "overview", label: "Suites", to: (k: WebDynamic) => `/p/${k}`,
    icon: '<rect x="2.5" y="2.8" width="11" height="4.2" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2.5" y="9" width="11" height="4.2" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 4.9h6M5 11.1h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' },
  { nav: "runs", label: "Runs", to: (k: WebDynamic) => `/p/${k}/runs`,
    icon: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.7 5.7 10.2 8l-3.5 2.3Z" fill="currentColor"/>' },
  { nav: "findings", label: "Findings", to: (k: WebDynamic) => `/p/${k}/findings`,
    icon: '<path d="M4.2 2.5v11M4.2 3.2h7.3L9.7 5.7l1.8 2.5H4.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' },
  // Appended before Settings rather than slotted next to Suites: the three
  // items people already navigate by keep their position.
  { nav: "personas", label: "Personas", to: (k: WebDynamic) => `/p/${k}/personas`,
    icon: '<circle cx="8" cy="5.4" r="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.2 13.6a4.9 4.9 0 0 1 9.6 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' },
  { nav: "settings", label: "Settings", to: (k: WebDynamic) => `/p/${k}/settings`,
    icon: '<path d="M2.5 5.2h1.6M8.3 5.2h5.2M2.5 10.8h5.2M11.9 10.8h1.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="6.2" cy="5.2" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="9.8" cy="10.8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/>' },
];

// Pages that live UNDER a rail item but aren't it. Without this, the authoring
// surfaces people spend the most time in — the suite page, story editor, Edit
// files, Versions, run history, and the changed-stories queue — rendered with
// every rail item inactive, so the console never said where you were.
const UNDER: WebDynamic = {
  suites: "overview",   // Suites is the project home
  review: "runs",       // a changed story is a run awaiting a decision
};

/** The rail item a page's `nav:` value should light up. */
export const railFor = (nav: WebDynamic) => (nav ? UNDER[nav] ?? nav : null);
