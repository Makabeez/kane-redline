// Case x target scoreboard from one or more ledgers. Latest final verdict wins per cell.
import { readFileSync, existsSync } from 'node:fs';

const MARK = { held: '✅ held', exploit_confirmed: '❌ **exploit**', false_positive: '⚠️ false positive',
  inconclusive: '❔ inconclusive', infra: '🔌 infra', infra_credits: '🔌 no credits',
  unreproduced_inconclusive: '❔ unreproduced', exploit_candidate_unconfirmed: '❔ unconfirmed' };

export function report(ledgers, { targets: only } = {}) {
  const cells = new Map(); const order = []; const tgts = []; const credits = new Map(); const meta = new Map();
  for (const path of ledgers) {
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let e; try { e = JSON.parse(raw); } catch { continue; }
      if (!e.case || !e.target || (only && !only.includes(e.target))) continue;
      if (!order.includes(e.case)) order.push(e.case);
      if (!tgts.includes(e.target)) tgts.push(e.target);
      if (e.invariant) meta.set(e.case, e.invariant);
      if (e.attempt) credits.set(e.target, (credits.get(e.target) ?? 0) + (e.credits_spent ?? e.credits_reported ?? 0));
      if (e.final) cells.set(`${e.case}|${e.target}`, e.final);
    }
  }
  const cols = only ?? tgts;
  const lines = [`| Case | Invariant | ${cols.join(' | ')} |`, `|---|---|${cols.map(() => '---').join('|')}|`];
  for (const c of order) lines.push(`| ${c} | ${meta.get(c) ?? ''} | ${cols.map((t) => MARK[cells.get(`${c}|${t}`)] ?? '·').join(' | ')} |`);
  const tally = cols.map((t) => {
    const v = order.map((c) => cells.get(`${c}|${t}`)).filter(Boolean);
    return `**${t}**: ${v.filter((x) => x === 'held').length}/${v.length} held, ${v.filter((x) => x === 'exploit_confirmed').length} exploit(s), ${(credits.get(t) ?? 0).toFixed(0)} credits`;
  });
  return lines.join('\n') + '\n\n' + tally.join(' · ') + '\n';
}
