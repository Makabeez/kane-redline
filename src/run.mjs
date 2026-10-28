// Run Kane _test.md cases with result_code triage and reproduce-before-blame.
// Used by `redline run` and by the Stop gate.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve, relative } from 'node:path';
import { summarize, classify, settle } from './triage.mjs';

// kane-cli is often installed in a user npm prefix that non-login shells don't put on PATH.
const KANE = () => process.env.REDLINE_KANE_BIN
  || [join(process.env.HOME ?? '', '.npm-global', 'bin', 'kane-cli')].find((p) => existsSync(p))
  || 'kane-cli';
// A reproduction run may exceed the cap by this much: a candidate must never go unconfirmed for budget reasons.
const REPRO_ALLOWANCE = 25;
const ENV = () => ({ ...process.env, KANE_CLI_USER_AGENT: 'kane-redline' });

// All *_test.md under a file or directory (recursive), skipping Kane's own output folders.
export function findCases(target) {
  target = resolve(target);
  if (!statSync(target).isDirectory()) return [target];
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (f.isDirectory()) { if (!f.name.startsWith('output-') && !f.name.startsWith('.')) walk(join(d, f.name)); }
      else if (f.name.endsWith('_test.md')) out.push(join(d, f.name));
    }
  };
  walk(target);
  return out;
}

// Finds the .redline folder that owns a path.
export function redlineRoot(start) {
  let d = resolve(start);
  while (d !== dirname(d)) {
    if (basename(d) === '.redline') return d;
    if (existsSync(join(d, '.redline'))) return join(d, '.redline');
    d = dirname(d);
  }
  return join(resolve(start), '.redline');
}

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export async function runCases({ target, url, targetName = 'app', maxCredits = 60, ledger, log = defaultLog }) {
  const files = findCases(target);
  const root = redlineRoot(statSync(resolve(target)).isDirectory() ? target : dirname(target));
  ledger = resolve(ledger ?? join(root, 'ledger.ndjson'));
  mkdirSync(dirname(ledger), { recursive: true });
  const meta = loadCaseMeta(files);
  const kaneVersion = sh([KANE(), '--version']).stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown';
  log(`redline · kane-cli ${kaneVersion} · ${files.length} case(s) · target ${targetName} ${url} · cap ${maxCredits} credits`);
  log(`ledger → ${ledger}`);

  let spent = 0;
  const finals = [];
  const write = (o) => appendFileSync(ledger, JSON.stringify(o) + '\n');
  const done = (code) => {
    log('\nresult');
    for (const f of finals) log(`  ${String(f.case).padEnd(5)} ${f.final}`);
    log(`credits spent this run: ${spent.toFixed(2)}`);
    return { code, finals, spent, ledger };
  };

  for (const file of files) {
    const m = { id: basename(file).match(/^[A-Z]+\d+/)?.[0] ?? basename(file), ...(meta[file] ?? {}) };
    const attempts = [];
    let last;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const cap = attempt === 1 ? maxCredits : maxCredits + REPRO_ALLOWANCE;
      if (spent >= cap) { log(`credit cap reached (${spent.toFixed(2)} ≥ ${cap}), stopping`); return done(2); }
      const r = await runOne(file, url, log);
      last = r;
      spent += r.credits_spent ?? r.credits_reported ?? 0;
      attempts.push(r.triage);
      write({ ts: new Date().toISOString(), case: m.id, invariant: m.invariant ?? null,
        file: relative(dirname(root), file), sha256: sha256(file), target: targetName, url,
        kane_version: kaneVersion, attempt, ...r });
      log(`  ${m.id} #${attempt}: ${r.triage}  rc=${r.result_code ?? '-'} ${r.reason_code ?? ''}  credits=${fmt(r.credits_spent ?? r.credits_reported)}  ${r.duration_s}s`);
      if (r.triage.startsWith('infra')) {
        log(`  infra failure: ${r.reason ?? r.stderr_tail ?? 'no result'} — stopping, nothing is blamed on the app`);
        finals.push({ case: m.id, final: r.triage, file, why: m.why, expect: m.expect, one_liner: r.one_liner });
        write({ ts: new Date().toISOString(), case: m.id, invariant: m.invariant ?? null, target: targetName, final: r.triage, attempts });
        return done(2);
      }
      if (r.triage === 'held') break;
    }
    const final = settle(attempts[0], attempts[1]);
    finals.push({ case: m.id, final, file, title: m.title, why: m.why, expect: m.expect,
      one_liner: last?.one_liner, reason: last?.reason, evidence: last?.evidence });
    write({ ts: new Date().toISOString(), case: m.id, invariant: m.invariant ?? null, target: targetName, final, attempts });
  }
  return done(finals.some((f) => f.final === 'exploit_confirmed') ? 1
    : finals.every((f) => f.final === 'held') ? 0 : 3);
}

async function runOne(file, url, log) {
  const before = balance();
  const t0 = Date.now();
  const events = [];
  let stderr = '';
  const code = await new Promise((res) => {
    const p = spawn(KANE(), ['testmd', 'run', file, '--agent', '--headless', '--url', url],
      { cwd: dirname(file), env: ENV(), stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!raw) continue;
        try {
          const e = JSON.parse(raw); events.push(e);
          if (e.type == null && e.status === 'done' && e.remark) log(`    · ${String(e.remark).slice(0, 110)}`);
        } catch { /* non-JSON line */ }
      }
    });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (c) => res(c));
    p.on('error', (err) => { stderr += String(err); res(127); });
  });
  const after = balance();
  const s = summarize(events);
  const triage = classify(s);
  return {
    exit: code, triage, ...s,
    duration_s: Math.round((Date.now() - t0) / 100) / 10,
    balance_before: before, balance_after: after,
    credits_spent: before != null && after != null ? Math.round((before - after) * 1e4) / 1e4 : null,
    evidence: stderr.match(/evidence serve (\S+)/)?.[1] ?? null,
    stderr_tail: triage.startsWith('infra') ? stderr.trim().split('\n').slice(-3).join(' | ') : undefined,
  };
}

function balance() {
  for (let i = 0; i < 2; i++) {
    const m = sh([KANE(), 'balance']).stdout.match(/Available credits:\s*([\d.]+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

function sh([bin, ...args]) {
  const r = spawnSync(bin, args, { env: ENV(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

function loadCaseMeta(files) {
  const out = {};
  for (const dir of new Set(files.map((f) => dirname(f)))) {
    const p = join(dir, 'cases.json');
    if (existsSync(p)) for (const c of JSON.parse(readFileSync(p, 'utf8'))) out[join(dir, c.file)] = c;
  }
  return out;
}

const fmt = (n) => (n == null ? '?' : Number(n).toFixed(2));
function defaultLog(m) { process.stderr.write(m + '\n'); }
