-- Rule cards: a suite's invariant statements and their review state
-- (docs/contracts/hosted.md, "Rule cards"; docs/contracts/scripts.md,
-- "Invariant levels"; DESIGN N6).
--
-- Level 0 needs no storage: the four spec-derived policies are code, on by
-- default, and no row can switch one off. This table is Level 1 — the sentences
-- the platform PROPOSED and the human then approved, edited, denied, or wrote
-- themselves. Only the approved ones are ever enforced, and that filter lives in
-- one SQL predicate (`approvedRuleCards`) rather than in a caller's discipline.
--
-- Three columns are load-bearing beyond the obvious:
--
--   * `state` is the governance boundary. `candidate` is the only state a model
--     can produce; `approved` is the only state that reaches a handout. A denied
--     row is KEPT — that is how a denial is remembered, so the same rule is not
--     proposed at the owner again next month.
--   * `proposed_statement` preserves what the model actually said when the human
--     edits the sentence. Without it, "8 cards approved unedited" and "8 cards
--     approved after being rewritten" look identical afterwards, and the second
--     is the interesting one for anyone tuning the prompt.
--   * `prompt_version` pins which instrument wrote the card. Cards outlive the
--     prompt that proposed them.
--
-- `rule_id` is the obligation slug: `rule:<rule_id>` is what the handout, the
-- manifest, and every report entry key off, so it is unique per suite and
-- immutable once minted. Editing a card's sentence never re-slugs it — an
-- obligation id that moved would silently orphan an authored check.
CREATE TABLE rule_cards (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id           TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  rule_id            TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('candidate', 'approved', 'denied')),
  origin             TEXT NOT NULL CHECK (origin IN ('proposed', 'authored')),
  title              TEXT,
  statement          TEXT NOT NULL,
  applicability      TEXT,
  exceptions         TEXT,
  provenance         TEXT,
  note               TEXT,
  proposed_statement TEXT,
  prompt_version     TEXT,
  decided_by         TEXT REFERENCES users(id),
  decided_at         INT_TS,
  created_at         INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at         INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (suite_id, rule_id)
);

CREATE INDEX rule_cards_suite_idx ON rule_cards(suite_id, state);
CREATE INDEX rule_cards_project_idx ON rule_cards(project_id);
