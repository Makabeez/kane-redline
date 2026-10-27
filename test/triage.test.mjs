import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, classify, settle } from '../src/triage.mjs';

// Real run_end from the 26 Oct spike (kane-cli 0.9.0), trimmed to the fields triage reads.
const spike = { type: 'run_end', status: 'failed', result_code: 320, reason_code: 'stuck.dag_cycle',
  credits_consumed: 27.746879999999997,
  verdict: { confirmed: false, family: 'automation_bug', category: 'agent_misstep', credits_consumed: 4.766 } };

test('spike: exit 1 but result_code 320 is inconclusive, never an exploit', () => {
  const s = summarize([{ step: 2, status: 'done', remark: 'navigate', v: 1 }, spike]);
  assert.equal(s.result_code, 320);
  assert.equal(s.verdict_family, 'automation_bug');
  assert.equal(s.credits_reported, 32.5129);
  assert.equal(classify(s), 'inconclusive');
});

test('7xx from an automation bug is not an exploit', () => {
  const s = summarize([{ type: 'run_end', status: 'failed', result_code: 701, verdict: { family: 'automation_bug' } }]);
  assert.equal(classify(s), 'inconclusive');
});

test('7xx without an automation verdict is an exploit candidate', () => {
  const s = summarize([{ type: 'run_end', status: 'failed', result_code: 701, verdict: { family: 'product_bug' } }]);
  assert.equal(classify(s), 'exploit_candidate');
});

test('pass needs 1xx and a passed test_md_done', () => {
  const s = summarize([{ type: 'run_end', status: 'passed', result_code: 100 }, { type: 'test_md_done', overall_status: 'passed' }]);
  assert.equal(classify(s), 'held');
});

test('infra wins over everything; 560 is out of credits', () => {
  assert.equal(classify(summarize([{ type: 'run_end', result_code: 701 }, { type: 'run_end', result_code: 503 }])), 'infra');
  assert.equal(classify(summarize([{ type: 'run_end', result_code: 560 }])), 'infra_credits');
  assert.equal(classify(summarize([])), 'infra');
});

test('a candidate is only an exploit if it reproduces', () => {
  assert.equal(settle('exploit_candidate', 'exploit_candidate'), 'exploit_confirmed');
  assert.equal(settle('exploit_candidate', 'held'), 'false_positive');
  assert.equal(settle('held'), 'held');
});
