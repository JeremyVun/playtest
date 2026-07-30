#!/usr/bin/env python3
"""Render report/index.html from report/data/study.json + the fault catalog.
Pure static output: no JS required to read the report."""
import json, html, os, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
STUDY = json.load(open(os.path.join(HERE, "data/study.json")))
CATALOG = json.load(open(os.path.join(HERE, "../catalog/catalog.json")))["faults"]
E = html.escape

FAULT = {f["id"]: f for f in CATALOG}
NICE = {"P": "Playtest (arm P)", "C": "Coding agent (arm C)"}

def fmt_min(ms): return f"{ms/60000:.0f} min"
def fmt_usd(v): return f"${v:,.2f}"
def pct(x): return f"{100*x:.0f}%"

def round_found(trial, fid, arm):
    for rd in STUDY["trials"][trial]["rounds"]:
        if fid in rd[f"new_seeded_{arm}"]:
            return rd["round"]
    return None

def verdict_chip(ok):
    cls = "pass" if ok else "fail"
    return f'<span class="chip {cls}">{"PASS" if ok else "FAIL"}</span>'

def headline_rows():
    rows = []
    for label, key, fmt in [
        ("Seeded faults found (of 20)", None, None),
        ("Latent issues credited", "latent", None),
        ("Invalid claims (non-duplicate)", "invalid", None),
        ("Wall clock, all rounds", "wall", None),
        ("Priced-equivalent model cost", "cost", None),
        ("Turns", "turns", None),
    ]:
        cells = []
        for t in ("t1", "t2"):
            tr = STUDY["trials"][t]
            for a in ("P", "C"):
                if label.startswith("Seeded"):
                    v = f"<strong>{len(tr[f'seeded_{a}'])}</strong>"
                elif key == "latent":
                    v = str(sum(rd["judge"].get(a, {}).get("latent", 0) for rd in tr["rounds"]))
                elif key == "invalid":
                    v = str(sum(rd["judge"].get(a, {}).get("invalid", 0) for rd in tr["rounds"]))
                elif key == "wall":
                    ms = sum(rd[f"arm{a}"]["wall_ms"] for rd in tr["rounds"])
                    v = fmt_min(ms)
                elif key == "cost":
                    v = fmt_usd(sum(rd[f"arm{a}"]["cost_usd"] for rd in tr["rounds"]))
                elif key == "turns":
                    if a == "P":
                        v = f"{sum(rd['armP']['steps'] for rd in tr['rounds'])} actor steps"
                    else:
                        v = f"{sum(rd['armC']['messages']+rd['armC']['tool_calls'] for rd in tr['rounds'])} msgs+calls"
                cells.append(f"<td>{v}</td>")
        rows.append(f"<tr><th>{E(label)}</th>{''.join(cells)}</tr>")
    return "\n".join(rows)

def convergence():
    out = []
    for t in ("t1", "t2"):
        tr = STUDY["trials"][t]
        body = []
        for rd in tr["rounds"]:
            body.append(
                f"<tr><td>{rd['round']}</td>"
                f"<td>{len(rd['new_seeded_P'])} new → <strong>{rd['cum_seeded_P']}</strong></td>"
                f"<td>{len(rd['new_seeded_C'])} new → <strong>{rd['cum_seeded_C']}</strong></td>"
                f"<td>{fmt_min(rd['armP']['wall_ms'])} / {fmt_min(rd['armC']['wall_ms'])}</td>"
                f"<td>{fmt_usd(rd['armP']['cost_usd'])} / {fmt_usd(rd['armC']['cost_usd'])}</td></tr>"
            )
        out.append(
            f"<h3>Trial {t[1]}</h3><table><thead><tr><th>Round</th><th>Playtest seeded</th>"
            f"<th>Agent seeded</th><th>Wall P / C</th><th>Cost P / C</th></tr></thead>"
            f"<tbody>{''.join(body)}</tbody></table>"
        )
    return "\n".join(out)

def fault_matrix():
    rows = []
    for f in CATALOG:
        fid = f["id"]
        cells = [f'<td class="mono">{E(fid)}</td>', f"<td>{E(f['scope'])} · {E(f['trigger'])} · {E(f['recognition'])}</td>"]
        for a in ("P", "C"):
            sub = []
            for t in ("t1", "t2"):
                r = round_found(t, fid, a)
                if r:
                    sub.append(f'<span class="found">R{r}</span>')
                else:
                    reached = STUDY["miss_analysis"].get(fid, {}).get(f"{a}_{t}")
                    sub.append('<span class="reached">reached</span>' if reached else '<span class="unreached">not reached</span>')
            cells.append(f"<td>{' / '.join(sub)}</td>")
        masked = f.get("masked_by")
        cells.append(f'<td class="mono">{E(masked) if masked else "—"}</td>')
        rows.append(f"<tr>{''.join(cells)}</tr>")
    return "\n".join(rows)

def b3_detail():
    out = []
    for t in ("t1", "t2"):
        for rd in STUDY["trials"][t]["rounds"]:
            b3 = next(x for x in STUDY["trials"][t]["verdicts"]["B3"]["per_round"] if x["round"] == rd["round"])
            subs = rd["judge"].get("P", {}).get("invalid_sublabels", {})
            sub_txt = ", ".join(f"{k} {v}" for k, v in sorted(subs.items())) or "—"
            out.append(
                f"<tr><td>{t[1]}</td><td>{rd['round']}</td><td>{b3['invalid']}/{b3['nondup']}"
                f" ({pct(b3['ratio']) if b3['ratio'] is not None else '—'})</td>"
                f"<td>{verdict_chip(b3['passes'])}</td><td>{E(sub_txt)}</td></tr>"
            )
    return "\n".join(out)

def verdict_cards():
    cards = []
    for name, desc in [
        ("B1", "Detection floor — Playtest cumulative seeded ≥ 70% of reachable faults"),
        ("B2", "Marginal value — Playtest unique seeded ≥ agent unique seeded + 3"),
        ("B3", "Noise ceiling — invalid ≤ ⅓ of Playtest claims, per round"),
        ("B4", "Budget — ≤ $75 and ≤ 8 h per arm per trial"),
    ]:
        chips = []
        for t in ("t1", "t2"):
            v = STUDY["trials"][t]["verdicts"][name]
            chips.append(f"<div>Trial {t[1]} {verdict_chip(v['passes'])}</div>")
        detail = ""
        v1 = STUDY["trials"]["t1"]["verdicts"][name]
        if name == "B1":
            detail = f"Both trials: 8/20 = {pct(v1['recall_masking_aware'])} (masking-aware and raw coincide — every fault became reachable by round 2)."
        if name == "B2":
            detail = "Both trials tied 8 vs 8 — no +3 margin in either direction."
        if name == "B3":
            detail = "Fails every round; see the noise table — most invalid claims are soft-ux/informational, not fabricated defects."
        if name == "B4":
            v2 = STUDY["trials"]["t2"]["verdicts"][name]
            detail = (f"T1: P {fmt_usd(v1['cost_P'])} / C {fmt_usd(v1['cost_C'])}; "
                      f"T2: P {fmt_usd(v2['cost_P'])} / C {fmt_usd(v2['cost_C'])} — all within budget.")
        cards.append(
            f'<div class="card"><div class="card-head"><span class="bar">{name}</span>{"".join(chips)}</div>'
            f"<p class=\"desc\">{E(desc)}</p><p>{E(detail)}</p></div>"
        )
    return "\n".join(cards)

t1, t2 = STUDY["trials"]["t1"], STUDY["trials"]["t2"]
p_only = sorted(set(t1["seeded_P"]) - set(t1["seeded_C"]))
c_only = sorted(set(t1["seeded_C"]) - set(t1["seeded_P"]))
never_reached = [f for f, r in STUDY["miss_analysis"].items() if not any(r.values())]
reached_unrecognized = [f for f in STUDY["miss_analysis"] if f not in never_reached]
oh = STUDY["overhead_tokens"]

page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Detection study — Playtest vs a coding agent (web)</title>
<style>
  :root {{
    --ink: #1a1a1f; --muted: #6b6b76; --line: #e4e4e9; --bg: #fbfbfc;
    --green: #106b3c; --green-bg: #e5f4ec; --red: #a4232c; --red-bg: #fbe9ea;
    --accent: #24427a; --reached: #9a6a00; --reached-bg: #fdf3d8;
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.55 "Charter", "Georgia", serif; }}
  main {{ max-width: 62rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; }}
  h1 {{ font-size: 1.9rem; line-height: 1.25; margin: 0 0 .3rem; }}
  h2 {{ font-size: 1.25rem; margin: 3rem 0 .8rem; border-bottom: 1px solid var(--line); padding-bottom: .4rem; }}
  h3 {{ font-size: 1.02rem; margin: 1.6rem 0 .5rem; }}
  .sub {{ color: var(--muted); margin: 0 0 2.2rem; }}
  table {{ border-collapse: collapse; width: 100%; font-size: .92rem;
    font-family: "SF Pro Text", "Segoe UI", system-ui, sans-serif; }}
  th, td {{ text-align: left; padding: .45rem .7rem; border-bottom: 1px solid var(--line);
    font-variant-numeric: tabular-nums; vertical-align: top; }}
  thead th {{ font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }}
  tbody th {{ font-weight: 600; }}
  .mono {{ font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .84rem; }}
  .chip {{ display: inline-block; font: 700 .72rem/1 "SF Pro Text", system-ui, sans-serif;
    letter-spacing: .06em; padding: .28em .6em; border-radius: 99px; }}
  .chip.pass {{ color: var(--green); background: var(--green-bg); }}
  .chip.fail {{ color: var(--red); background: var(--red-bg); }}
  .found {{ color: var(--green); font-weight: 700; }}
  .reached {{ color: var(--reached); background: var(--reached-bg); padding: 0 .35em; border-radius: 4px; }}
  .unreached {{ color: var(--muted); }}
  .cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: 1rem; }}
  .card {{ background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.1rem;
    font-family: "SF Pro Text", system-ui, sans-serif; font-size: .9rem; }}
  .card-head {{ display: flex; gap: .8rem; align-items: center; margin-bottom: .5rem; }}
  .card-head .bar {{ font-weight: 800; font-size: 1.05rem; color: var(--accent); }}
  .card-head div {{ display: flex; gap: .35rem; align-items: center; font-size: .8rem; color: var(--muted); }}
  .desc {{ color: var(--muted); margin: .2rem 0 .5rem; }}
  .note {{ background: #fff; border-left: 3px solid var(--accent); padding: .8rem 1rem; margin: 1rem 0;
    font-size: .95rem; }}
  .headline td:nth-child(2), .headline td:nth-child(3) {{ border-right: none; }}
  .headline td:nth-child(3) {{ border-right: 2px solid var(--line); }}
  ul {{ padding-left: 1.2rem; }}
  li {{ margin: .35rem 0; }}
  a {{ color: var(--accent); }}
  .foot {{ margin-top: 3rem; color: var(--muted); font-size: .85rem; }}
</style>
</head>
<body>
<main>
<h1>Same app, same bugs, same stories:<br>Playtest vs a coding agent with a browser</h1>
<p class="sub">Two frozen trials · 20 seeded faults · up to 3 fix-and-retest rounds per arm ·
gpt-5.5 actor on both arms · arm-blind Fable&nbsp;5 judge · 2026-07-30/31</p>

<div class="note"><strong>One-minute read.</strong> Both methods found exactly the same
<strong>8 of 20</strong> seeded faults in both trials — but not the same 8. Playtest uniquely caught the
two arithmetic faults (wrong bundle-discount threshold, wrong late-fee day count) that require checking
displayed numbers against the spec; the coding agent uniquely caught two interaction faults
(a transient mislabeled button, an off-by-one extension limit). Detection converged by round&nbsp;2 in
every case; round&nbsp;3 added nothing for either arm in either trial. Playtest cost ~35% less per trial
but took ~2× the wall clock. Of the 10 faults neither arm found, 4 were never even reached — a
story-coverage ceiling, not a recognition failure. All pre-registered detection bars (B1, B2) failed
for both arms in both trials, identically — the honest headline is that <em>neither method cleared a 40%
recall ceiling</em> on this catalog, and their union reached only 50%.</div>

<h2>Headline</h2>
<table class="headline">
<thead><tr><th></th><th>T1 · Playtest</th><th>T1 · Agent</th><th>T2 · Playtest</th><th>T2 · Agent</th></tr></thead>
<tbody>
{headline_rows()}
</tbody>
</table>
<p class="desc" style="font-family: system-ui, sans-serif; font-size:.85rem; color: var(--muted);">
Latent = real defects verified on the clean reference but not in the catalog (the subject shipped with
3 known validation quirks; both arms rediscovered them every round — recurrences are deduplicated within
each round, not across rounds). Invalid counts include soft-ux and informational claims — see the noise
breakdown. Costs are priced-equivalents from token usage ($5/$30/$0.50 per M in/out/cache-read);
infrastructure cost was $0 (local machine). <strong>Replication delta ≈ 0:</strong> per-arm seeded sets
were identical across trials, round by round.</p>

<h2>Pre-registered verdicts</h2>
<div class="cards">
{verdict_cards()}
</div>

<h2>Convergence by round</h2>
{convergence()}
<p class="desc" style="font-family: system-ui, sans-serif; font-size:.85rem; color: var(--muted);">
After each round every correctly-reported fault was withdrawn from that arm's copy and the app rebuilt —
withdrawal <em>simulates</em> a fix; nothing here generated or verified real fixes. Round 2's new finds are
exactly the two faults that were masked behind round-1 faults (a dead confirm behind a missing button, an
off-by-one behind a missing block) — the round loop exposed them as designed, and both arms caught the
unmasked dead-confirm immediately.</p>

<h2>Per-fault matrix</h2>
<table>
<thead><tr><th>Fault</th><th>Class</th><th>Playtest (T1 / T2)</th><th>Agent (T1 / T2)</th><th>Masked by</th></tr></thead>
<tbody>
{fault_matrix()}
</tbody>
</table>
<p class="desc" style="font-family: system-ui, sans-serif; font-size:.85rem; color: var(--muted);">
R<i>n</i> = credited by the arm-blind judge in round <i>n</i>. For misses, hidden server-side trigger
telemetry (diagnostic only — invisible to both arms, never used for scoring) distinguishes
<span class="reached">reached</span> (the trigger path was exercised but the wrongness went unrecognized)
from <span class="unreached">not reached</span> (the stories never took the arm there).</p>

<h3>What the misses say</h3>
<ul>
<li><strong>Never reached by either arm ({len(never_reached)}):</strong> {E(", ".join(never_reached))}.
These sit on surfaces the frozen stories never forced (empty catalogue search, unknown-id pages, the
overdue-vs-out filter distinction, Saturday due-date rolls) — the story author flagged these exact
coverage gaps at authoring time. Detection here is bounded by story coverage, replicating the July
hill-climb's core lesson.</li>
<li><strong>Reached but unrecognized ({len(reached_unrecognized)}):</strong> {E(", ".join(reached_unrecognized))}.
Notable: the 0.6-second transient status-line faults (<span class="mono">f-decline-status-line</span>,
reached by both arms in every trial) are effectively invisible to both instruments — snapshots are taken
after actions settle. <span class="mono">f-charges-late-fee</span> was reached only by the agent, which
checked the tile before the late fee existed.</li>
<li><strong>Unique finds:</strong> Playtest-only: {E(", ".join(p_only))} — both are
plausible-but-wrong <em>values</em>, caught because journey gates pin spec numbers like $35.10 and
$45.00. Agent-only: {E(", ".join(c_only))} — a mid-action label and an
off-by-one that needs doing the action twice; Playtest's gate for the second extension was dropped in
calibration because the refusal renders below its snapshot fold (a measured instrument cost).</li>
</ul>

<h2>Noise (B3 detail)</h2>
<table>
<thead><tr><th>Trial</th><th>Round</th><th>Playtest invalid / claims</th><th>≤ ⅓?</th><th>Invalid sublabels</th></tr></thead>
<tbody>
{b3_detail()}
</tbody>
</table>
<p class="desc" style="font-family: system-ui, sans-serif; font-size:.85rem; color: var(--muted);">
B3 fails in every round under the frozen definition. The texture matters: the dominant sublabels are
<em>soft-ux</em> (a11y contrast bundles, discoverability notes) and <em>not-a-bug</em> (correct-behavior
observations from discovery synthesis, plus claims about UI parts that the capture window provably
omits). Fabricated defect claims were rare; the product's findings feed simply mixes defect claims with
observations, and the frozen bar counts them all. The agent's reports were terse and mostly credited
(its invalid count was 1–2 per round).</p>

<h2>Costs and overhead</h2>
<table>
<thead><tr><th></th><th>Trial 1</th><th>Trial 2</th></tr></thead>
<tbody>
<tr><th>Playtest, 3 rounds</th><td>{fmt_usd(t1['verdicts']['B4']['cost_P'])} · {t1['verdicts']['B4']['wall_P_min']:.0f} min</td>
<td>{fmt_usd(t2['verdicts']['B4']['cost_P'])} · {t2['verdicts']['B4']['wall_P_min']:.0f} min</td></tr>
<tr><th>Agent, 3 rounds</th><td>{fmt_usd(t1['verdicts']['B4']['cost_C'])} · {t1['verdicts']['B4']['wall_C_min']:.0f} min</td>
<td>{fmt_usd(t2['verdicts']['B4']['cost_C'])} · {t2['verdicts']['B4']['wall_C_min']:.0f} min</td></tr>
</tbody>
</table>
<p class="desc" style="font-family: system-ui, sans-serif; font-size:.85rem; color: var(--muted);">
Shared study overhead, excluded from arm costs (symmetric): Fable&nbsp;5 judge
{oh['judge_fable']['t1']+oh['judge_fable']['t2']:,} tokens across both trials
(+{oh['judge_fable']['dry_run']:,} in the calibration dry-run); Opus&nbsp;5 authors
(subject, stories, catalog, gate recalibration) {sum(v for k,v in oh['authors_opus'].items() if isinstance(v,int)):,} tokens.
Judge/author tokens are Claude-side and are reported as raw tokens per the pre-registration.
Pre-measurement shakedown consumed ≈{fmt_usd(STUDY['shakedown']['armP_cost_usd']+STUDY['shakedown']['armC_cost_usd'])}
of gateway usage.</p>

<h2>Method notes a reader should not skip</h2>
<ul>
<li><strong>Withdrawal simulates fixes.</strong> No fixes were generated or verified; "fixed" means the
fault's patch was removed from that arm's next build.</li>
<li><strong>The subject shipped with 3 real latent bugs</strong> (validation-message quirks), discovered by
both arms in calibration and adjudicated as accepted quirks before measurement. Both arms re-found them in
every measured round; the judge verified each against the clean reference and credited them as latent.</li>
<li><strong>Instrument visibility shaped the result.</strong> Playtest's journey grader sees a condensed
snapshot that omits the site header, bare-number table cells, and below-fold content; gates were
recalibrated to visible facts on the known-correct build before measurement (frozen at G4), and one
seeded fault (the extension off-by-one) became undetectable to arm P's gates as a direct consequence.</li>
<li><strong>One product bug was found and fixed mid-study</strong> under the pre-registered
product-bug clause: hosted clean-replays crashed because a Map didn't survive a JSON process boundary
(runner fix <span class="mono">916bacf</span>); the affected round was excluded and fully re-measured.
The round-ordering rule was violated once as a side effect (logged in PINS).</li>
<li><strong>Two trials, descriptive variance only</strong> — and the variance was ≈0: identical per-arm
fault sets, round by round. Judge bucket counts varied slightly (invalid/latent boundary on a11y and
console-noise claims), never the seeded verdicts.</li>
<li><strong>Both-arms union = 10/20.</strong> A skeptical reading: on this subject, black-box AI
detection with these stories has a hard coverage/recognition ceiling near 50%, and the product-vs-agent
choice moves <em>which</em> faults you get (value math vs interaction edges), cost, and wall time — not
the count.</li>
</ul>

<h2>Machine-readable evidence</h2>
<ul>
<li><a href="data/study.json">study.json</a> — consolidated metrics, per-round data, verdicts.</li>
<li><a href="data/ledgers/">ledgers/</a> — per-round arm-blind judge ledgers (t1-r1 … t2-r3) with
per-claim verdicts, rationales, confidences, provenance, human-audit files, and overrides.</li>
<li><a href="data/telemetry/">telemetry/</a> — hidden trigger-probe events per build (diagnostic).</li>
<li><span class="mono">lint-evidence.mjs</span> — re-derives every headline number from the ledgers;
CI-runnable.</li>
</ul>

<p class="foot">Pre-registration: <span class="mono">studies/detection-web/PREREG.md</span> (G0
<span class="mono">e60bf78</span>); artifact freezes in <span class="mono">PINS.md</span>; scoring rules in
<span class="mono">SCORING.md</span>; accepted quirks in <span class="mono">QUIRKS.md</span>. Subject
<span class="mono">7f45ff3</span> · suite <span class="mono">f7100b6</span>+<span class="mono">d2bf39e</span> ·
catalog <span class="mono">cb6692b</span>. Generated {datetime.date.today().isoformat()} by build-report.py.</p>
</main>
</body>
</html>"""

open(os.path.join(HERE, "index.html"), "w").write(page)
print("index.html written,", len(page), "bytes")
