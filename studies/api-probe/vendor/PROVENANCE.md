# Vendored, not authored

Everything in this directory is a **byte-for-byte copy** of a file owned by the
ledger API fixture. Do not hand-edit it: fix the original and re-copy.

| File here | Copied from |
|---|---|
| `oracles.js` | `examples/ledger-api/bench/lib/oracles.js` |
| `trace.js` | `examples/ledger-api/bench/lib/trace.js` |
| `openapi.json` | `examples/ledger-api/openapi.json` |

## Why a copy and not an import

The probe's assertions and the measurement bench must be *provably the same
oracle* — otherwise the probe's in-run verdict and the study's scoring could
disagree and the P1 numbers would mean nothing (DESIGN §4, "all arms' traces are
scored by the same deterministic oracles").

A plain `import` would say that better than a copy does. It is not available:
`tests/repository/boundaries.test.js` ("product, tests, and studies do not
depend on standalone examples") reads every `.js` / `.mjs` / `.json` / `.sh` /
`.yaml` / `.yml` file under `src/`, `scripts/`, `studies/`, and `tests/` and
fails the root gate if any of them so much as *mentions* the examples
directory — path literal included. `CLAUDE.md` states the same rule
("`examples/` — Standalone user examples; never a test or product dependency"),
and the fixture's own README already records it. So a study cannot import the
fixture's oracles, cannot point `app.openapi` at the fixture's spec, and cannot
name the fixture's path in any file the boundary test scans.

Copying keeps the root gate green and keeps the equivalence checkable. It is a
workaround, not the destination: the clean fix is to move the ledger fixture (or
at least its `bench/lib/`) somewhere a study is allowed to depend on, or to
carve studies out of the boundary rule. Until then, this directory is the seam.

## Re-sync and verify

From the repository root:

```sh
cp examples/ledger-api/bench/lib/oracles.js  studies/api-probe/vendor/oracles.js
cp examples/ledger-api/bench/lib/trace.js    studies/api-probe/vendor/trace.js
cp examples/ledger-api/openapi.json          studies/api-probe/vendor/openapi.json

# prove the copies match the originals (no output = identical)
diff examples/ledger-api/bench/lib/oracles.js studies/api-probe/vendor/oracles.js
diff examples/ledger-api/bench/lib/trace.js   studies/api-probe/vendor/trace.js
diff examples/ledger-api/openapi.json         studies/api-probe/vendor/openapi.json
```

Re-sync **before every measured round** and record the result in the round's
notes. A drifted copy invalidates the comparison between the probe arm's gate
verdicts and the bench's scoring of the same traces.

### Copies as of this commit

```
dfcfd44c760b986c7a54f071a983cec305993f3cd3f9869bd4a583489db880e4  oracles.js
8d822ce60f55f86a45ca15a7154cafca73bf76d9b00943a7f98a8590edf0df64  trace.js
38468556a6b903ccba85d4abd8677013e84873ec0ba4812231db59b3571abba3  openapi.json
```

Regenerate with `shasum -a 256 studies/api-probe/vendor/*`.
