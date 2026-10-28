// Turn Kane's NDJSON for one test file into a verdict Redline can act on.
// Rule: result_code and verdict.family decide, never the process exit code.
// (Spike, 26 Oct: exit=1 "assertion failed" was really result_code 320, an automation loop.)

export function summarize(events) {
  const runEnds = events.filter((e) => e.type === 'run_end');
  const mdDone = events.filter((e) => e.type === 'test_md_done').pop();
  const codes = runEnds.map((e) => Number(e.result_code)).filter((n) => !Number.isNaN(n));
  // Verdicts come from the WORST run_end only: a healed setup step can carry an automation
  // verdict (e.g. locator_rot) while the assertion step itself is a confirmed product bug.
  const credits = runEnds.reduce((s, e) => s + (Number(e.credits_consumed) || 0)
    + (Number(e.verdict?.credits_consumed) || 0), 0);
  const worst = runEnds.slice().sort((a, b) => rank(b.result_code) - rank(a.result_code))[0];
  const v = worst?.verdict ?? null;
  return {
    overall: mdDone?.overall_status ?? worst?.status ?? null,
    codes,
    result_code: worst ? Number(worst.result_code) : null,
    reason_code: worst?.reason_code ?? null,
    reason: worst?.reason ?? null,
    one_liner: worst?.one_liner ?? null,
    verdict_family: v?.family ?? null,
    verdict_category: v?.category ?? null,
    verdict_confirmed: v?.confirmed === true,
    product_bug: /confirmed_product_bug/.test(worst?.reason_code ?? '') || v?.family === 'product_bug',
    session_id: mdDone?.session_id ?? null,
    run_dir: worst?.run_dir ?? null,
    credits_reported: round4(credits),
    steps: events.filter((e) => e.type == null && 'step' in e && e.status === 'done').length,
  };
}

// Severity: infra/blocker > assertion > stuck/agent error > pass
function rank(code) {
  const c = Number(code);
  if (c >= 500 && c < 700) return 4;
  if (c >= 700 && c < 800) return 3;
  if (c >= 300 && c < 500) return 2;
  if (c >= 100 && c < 200) return 1;
  return 0;
}

// held | exploit_candidate | inconclusive | infra | infra_credits
export function classify(s) {
  if (s.codes.includes(560)) return 'infra_credits';
  if (s.codes.some((c) => c >= 500 && c < 700)) return 'infra';
  if (s.codes.some((c) => c >= 700 && c < 800)) {
    if (s.product_bug) return 'exploit_candidate'; // Kane's own reason code wins
    return s.verdict_family === 'automation_bug' ? 'inconclusive' : 'exploit_candidate';
  }
  if (s.codes.some((c) => c >= 300 && c < 500)) return 'inconclusive';
  if (s.overall === 'passed' && s.codes.every((c) => c >= 100 && c < 200)) return 'held';
  if (s.overall === 'failed' && s.codes.length === 0) return 'exploit_candidate'; // test_md_done only
  if (s.overall == null && s.codes.length === 0) return 'infra'; // no result at all
  return 'inconclusive';
}

// Two attempts -> final verdict. A candidate only becomes an exploit if it reproduces.
export function settle(first, second) {
  if (!second) return first;
  if (first === 'exploit_candidate') {
    return second === 'exploit_candidate' ? 'exploit_confirmed'
      : second === 'held' ? 'false_positive' : `unreproduced_${second}`;
  }
  if (first === 'inconclusive') return second === 'exploit_candidate' ? 'exploit_candidate_unconfirmed' : second;
  return second;
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;
