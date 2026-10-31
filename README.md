<div align="center">

<img src="assets/banner.svg" alt="redline" width="860"/>

**Coding agents ship money UIs that pass their own tests and still show the wrong number on the first awkward input.**<br/>
**Redline turns Kane CLI into a red team inside the agent loop: adversarial browser cases with exact expected values, a Stop gate the agent can't talk past, and replays that cost 0 credits.**

[![Live demo](https://img.shields.io/badge/live_demo-RiskDesk-ff3b30?style=for-the-badge)]({{LIVE_URL}})
[![Video](https://img.shields.io/badge/video-2:59-0d1117?style=for-the-badge&logo=youtube)]({{VIDEO_URL}})
[![Evidence](https://img.shields.io/badge/evidence-riskdesk_repo-1f6feb?style=for-the-badge&logo=github)](https://github.com/Makabeez/riskdesk)
[![License](https://img.shields.io/badge/license-MIT-3fb950?style=for-the-badge)](LICENSE)

![Kane CLI](https://img.shields.io/badge/Kane_CLI-0.10.0-555?style=flat-square) ![Claude Code](https://img.shields.io/badge/Claude_Code-hooks-555?style=flat-square) ![Node](https://img.shields.io/badge/node-%E2%89%A520-555?style=flat-square) ![deps](https://img.shields.io/badge/runtime_deps-0-555?style=flat-square) ![tests](https://img.shields.io/badge/tests-14%2F14-3fb950?style=flat-square)

</div>

---

## Results first

One PRD (a position-size calculator and trade journal, [RiskDesk](https://github.com/Makabeez/riskdesk)). Three Claude models each built it in **one shot from the same single prompt**. Redline attacked every build with the same **34 adversarial cases**, each run in a real browser by Kane CLI and reproduced before it counts.

| Build (one prompt, no human edits) | Held | Confirmed bugs | What Kane saw on the page |
|---|---|---|---|
| Opus one-shot | **25 / 25** | 0 | — |
| Sonnet 5.5 one-shot | 18 / 25 | **2** | **99.9 SOL** where the PRD's math gives **100.0** · **24.99 ETH** where it gives **25.00** |
| Haiku 5.5 one-shot | 23 / 25 | **2** | the same two: 99.9 SOL / $29.97 and 24.99 ETH |
| Opus after change request v1.1 (fees, new instrument) | **34 / 34** | 0 | — |
| Haiku behind the Redline gate, v1.1 | **9 / 9** | 0 | its C05 bug was caught **by the gate** and fixed by the agent (below) |

Every one of those builds had passing unit tests written by the agent that built it. Sonnet even "confirmed every PRD oracle" in its final message, with a node one-liner, never in a browser. The four bugs are the same two float traps in two different codebases (`Math.floor(rawSize / lotStep)` in Haiku's, `Math.floor(value * factor) / factor` in Sonnet's), and **the case generator predicted both before either app existed**: `exact.mjs` computes that a naive double floor lands one lot short on exactly those inputs.

Not counted as bugs, and listed below under [Redline was wrong here](#redline-was-wrong-here): 3 Sonnet cases where Kane reported a "confirmed product bug" twice, but the code is correct.

Full scoreboard (127 Kane runs, 6,096 credits): [`riskdesk/matrix/REPORT.md`](https://github.com/Makabeez/riskdesk/blob/main/matrix/REPORT.md). Every cell comes from a committed ledger line.

## The closed loop, on camera

29 Oct, 22:13–22:24 CET, recorded in one take, no human typing after the first prompt ([video]({{VIDEO_URL}}), [ledger](https://github.com/Makabeez/riskdesk/blob/exp/haiku-gated-v11/.redline/ledger.ndjson)):

1. Haiku 5.5 is handed its own one-shot build, now guarded by Redline (C04, C05, C08 locked), and the v1.1 change request.
2. 20 seconds in it runs `ls -R .redline` in a chained command. **The tamper guard blocks it** and logs it. (That one was a false positive; see below.)
3. It implements fees and XRP, its 18 unit tests pass, tsc and build are clean, and it says done.
4. **The Stop gate replays the three locked cases in Chrome and blocks the stop:**
   ```
   Redline: 1 locked case(s) now fail in a real browser (reproduced twice by Kane CLI):
   - C05: Float trap on ETH with a 30-cent stop
     Expected: {"size":"25.00 ETH","actualRisk":"7.50"}
     Kane: The Result panel displays 24.99 ETH even though the configured risk calculation requires 25.00 ETH.
   Fix the application code so these cases hold again. Do not edit anything under .redline/.
   ```
5. Haiku reproduces the exact float operations in node, finds that its 1e-9 absolute tolerance is smaller than the 1.5e-9-lot error, makes it relative, and tries to stop again.
6. **Gate: `3/3 locked cases held`.** Every later stop replays the same three cases for **0.00 credits** in about 15 s each.

## How it works

```
                 ┌──────────── PRD + invariants.yml ────────────┐
                 │  exact BigInt math (gen/exact.mjs) computes   │
                 │  inputs where naive code breaks, and the      │
                 │  exact display a correct app must show        │
                 └───────────────┬───────────────────────────────┘
                                 ▼
      .redline/cases/*/C04-float-trap-…_test.md      (short, concrete, exact oracle)
                                 │
  agent edits code ──► PreToolUse hook ── locked path? ──► BLOCK + ledger "tamper_blocked"
                                 │
  agent says "done" ─► Stop hook ─► lock hashes intact? ─► app reachable? ─► unchanged since green? ─► allow
                                 │
                       kane-cli testmd run (replay: 0 credits)
                                 │
              result_code + verdict ─► triage ─┬─ 1xx  held
                                                ├─ 7xx  candidate ─► rerun ─► reproduced? ─► exploit ─► BLOCK with brief
                                                ├─ 3xx/4xx inconclusive (never blamed on the agent)
                                                └─ 5xx/6xx infra, 560 out of credits ─► stop, tell the human
```

| Piece | What it does | File |
|---|---|---|
| Case generators | Exact-arithmetic oracles from the PRD; every expected value also cross-checked with Python `Decimal` | [`riskdesk/.redline/gen`](https://github.com/Makabeez/riskdesk/tree/main/.redline/gen) |
| Runner | `kane-cli testmd run --agent --headless`, NDJSON parsing, two credit sources per run (`run_end.credits_consumed` and `kane-cli balance` diff), ledger | `src/run.mjs` |
| Triage | `result_code` + the failing step's `verdict`, **never the exit code**; a candidate must reproduce | `src/triage.mjs` |
| Tamper guard | Blocks Write/Edit on `.redline/`, `*_test.md`, `.claude/settings.json`; quote-aware shell parsing blocks `sed -i`, redirects, `rm`, `git checkout -- .redline`, substitutions | `src/guard.mjs` |
| Stop gate | SHA-256 lock check, replays the locked set, blocks with a short brief, escalates to the human after 5 blocked stops | `src/guard.mjs` |
| Scoreboard | Case × build table from any number of ledgers | `src/report.mjs` |

Zero runtime dependencies. 14 tests, including two built from real Kane events captured during the week.

## Install

```bash
npm i -g github:Makabeez/kane-redline         # needs kane-cli logged in (kane-cli whoami)
cd your-app
redline init --url http://localhost:5173     # writes hooks into .claude/settings.json, CLAUDE.md block, lock
redline run .redline/cases --url http://localhost:5173 --target local
redline report                               # scoreboard from .redline/ledger.ndjson
```

`init` locks whatever is under `.redline/cases` (any `*_test.md`), so it works with hand-written Kane tests too. The generators that produced RiskDesk's cases live in the evidence repo and are the template for writing your own.

## What a week of real runs measured

| | Value | Source |
|---|---|---|
| Authoring a case (first run, Kane plans every step) | 38–50 credits, ~100 s | 127 matrix runs + 10 baseline runs |
| Replaying a learned case | **0.00 credits, ~16 s** (31 replays) | `riskdesk/.redline/ledger.ndjson` |
| Replays survive | a copied folder · the agent re-laying out the form · a new field | 26–28 Oct ledger |
| Replays don't survive | a different app with different markup: Kane re-heals the changed steps (15–20 credits) | Haiku gated session |
| Exit code vs truth | spike run exited `1` ("assertion failed"); `result_code` was `320 stuck.dag_cycle` | 26 Oct spike |

## Redline was wrong here

Published on purpose: these are the limits a judge would otherwise have to find.

1. **Sonnet P01–P03: three false "exploits".** Kane reported `740 confirmed_product_bug`, reproduced, on the cleanup step ("the trade stays in the Journal after its deletion is confirmed"). Code review shows Sonnet's delete is correct: it confirms with the browser's native `window.confirm()`, which a headless Kane run can't accept, so the dialog is dismissed and nothing is deleted. Reproduce-before-blame doesn't help when the automation is stuck the same way twice. Two fixes follow from it: cleanup steps should never be able to fail a case, and native dialogs need a triage rule. R02 failed the same way once and then didn't reproduce.
2. **An over-specified oracle.** The first INV-01 wording checked "the risk budget the page shows under Risk per trade". The PRD never asks for that text; Opus just happened to render it. In the gated run Haiku *added the text to satisfy the case*. Fixed in `b9a6bd0`; every matrix result uses the corrected wording.
3. **Two tamper-guard false positives.** It blocked `ls -R .redline` (in a chain with `;` and `2>/dev/null`) and a `jq` filter whose `|` was inside quotes. Both were reads. Fixed in `61a2b53` with a quote-aware parser; both commands are now regression tests.
4. **Open-ended attacks don't work.** The first design gave Kane a goal ("make the risk exceed the budget, try 8 combinations"). It looped after 97 s, never stored the values it typed, and left nothing replayable. Redline generates the concrete inputs itself; Kane is the hands, not the attacker's brain.
5. **Haiku's fix is a tolerance, not exact math.** It passes all locked cases, but a relative epsilon can still be beaten by inputs nobody generated yet.
6. **N03 on Sonnet is inconclusive** (`720`, then `330 stuck`): Kane never reached the invalid stop state, so nothing is claimed either way.

## Real vs simulated

| Claim | Status |
|---|---|
| All Kane runs, codes, credits, durations | **Real**, from `kane-cli` 0.9.0 / 0.10.0 on one TestMu account, every line in a committed ledger |
| The four bugs | **Real**: shipped by the model, untouched by a human, seen on the page by Kane, root cause located in the code |
| The closed loop | **Real**: one continuous recording, no human input after the prompt |
| The builds | Generated by Claude Code with a single prompt each; prompts and full histories on the `exp/*` branches |
| Unit tests in this repo | Use a fake `kane-cli` replaying real event shapes |

## Prior art

Last round's silver, [GuardianKane](https://github.com/18Abhinav07/adventures-with-kane), already gates Claude Code's Stop on Kane and catches test tampering. Redline is built on that same gate pattern and changes what goes through it: **adversarial inputs generated from exact math instead of tests written from the spec**, triage on `result_code` instead of exit codes, and a locked set that replays for free on every stop instead of per task. Credit where it's due.

## License

MIT. Built for the TestMu AI Kane CLI hackathon, 26 Oct – 2 Nov 2026.
