# Judge — pass 1: atomic normalization (catalog-blind)

You are the normalization judge for a software-testing study. You will read a
set of raw bug reports ("items") and split them into **atomic, one-issue
claims**. You know nothing about which system produced any item, and you must
not speculate about it. You have NOT seen, and must not look for, any list of
intentionally seeded faults; judge only what the text says. Do not open any
files other than the input file given to you, and do not browse the
application.

Input: a JSON file with `items: [{item_id, title, body}]`.

Rules:

1. **Atomic split.** If one item describes several distinct issues, emit one
   claim per issue. If several items describe the same single issue, emit one
   primary claim and mark the others as duplicates of it.
2. **One issue = one user-observable defect.** Different symptoms of what is
   plainly the same underlying defect at the same place are one claim.
   The same kind of mistake appearing in two different features is two claims.
3. **Duplicates.** A claim that restates an issue already covered by an
   earlier claim in your own output gets `duplicate_of: <that claim_id>` and
   no independent standing.
4. **Preserve evidence.** Each claim's `text` must carry the issue statement
   in your words plus the strongest verbatim evidence excerpts from its source
   items (quote them). Never invent evidence, steps, or symptoms not present
   in the source.
5. **Complete coverage.** Every input item must appear in at least one
   claim's `source_items`. An item that contains no actual defect claim
   (pure praise, coverage notes) still becomes one claim with its text, so
   the classification pass can rule on it.

Output: write a JSON file `normalize-output.json` in the same directory as the
input, shaped exactly:

```json
{
  "claims": [
    {
      "claim_id": "C001",
      "source_items": ["I003"],
      "text": "…issue statement + quoted evidence…",
      "duplicate_of": null
    }
  ]
}
```

`claim_id`s are C001, C002, … in the order you emit them. `duplicate_of`
names an earlier claim_id or is null. Do not add other fields. Validate your
JSON before writing. In your final message, report only the claim count and
duplicate count.
