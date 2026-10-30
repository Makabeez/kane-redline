import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { report } from '../src/report.mjs';

test('latest final per case x target, with tallies', () => {
  const d = mkdtempSync(join(tmpdir(), 'rl-')); const p = join(d, 'l.ndjson');
  const L = (o) => JSON.stringify(o);
  writeFileSync(p, [
    L({ case: 'C04', invariant: 'INV-01', target: 'opus', attempt: 1, credits_spent: 30 }), L({ case: 'C04', target: 'opus', final: 'held' }),
    L({ case: 'C04', invariant: 'INV-01', target: 'haiku', attempt: 1, credits_spent: 40 }), L({ case: 'C04', target: 'haiku', final: 'exploit_confirmed' }),
    L({ case: 'C04', target: 'haiku', final: 'held' }), // later run after a fix wins
  ].join('\n'));
  const out = report([p]);
  assert.match(out, /\| C04 \| INV-01 \| ✅ held \| ✅ held \|/);
  assert.match(out, /\*\*haiku\*\*: 1\/1 held, 0 exploit\(s\), 40 credits/);
  assert.match(report([p], { targets: ['haiku'] }), /\| C04 \| INV-01 \| ✅ held \|/);
});
