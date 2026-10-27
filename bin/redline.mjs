#!/usr/bin/env node
// redline run <case.md | dir> --url <app> [--target <name>] [--max-credits N] [--ledger path]
//
// Runs each Kane _test.md once; reruns once if the result is an exploit candidate
// (to reproduce it) or inconclusive (3xx/4xx). Appends one line per attempt to
// .redline/ledger.ndjson. Halts on infra codes (5xx/6xx, 560 = out of credits).
//
// Exit: 0 all held · 1 exploit confirmed · 2 halted on infra or credit cap · 3 inconclusive/false positives only

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { summarize, classify, settle } from '../src/triage.mjs';

const KANE = process.env.REDLINE_KANE_BIN || 'kane-cli';
const ENV = { ...process.env, KANE_CLI_USER_AGENT: 'kane-redline' };

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

if (cmd !== 'run' || !argv[1]) {
  console.error('usage: redline run <case_test.md | dir> --url <app url> [--target name] [--max-credits N] [--ledger path]');
  process.exit(64);
}

const target = resolve(argv[1]);
const url = opt('--url', process.env.REDLINE_APP_URL);
const targetName = opt('--target', 'app');
const maxCredits = Number(opt('--max-credits', '60'));
if (!url) { console.error('redline: --url (or REDLINE_APP_URL) is required'); process.exit(64); }

const files = statSync(target).isDirectory()
  ? readdirSync(target).filter((f) => f.endsWith('_test.md')).sort().map((f) => join(target, f))
  : [target];
const ledger = resolve(opt('--ledger', join(findRedlineRoot(dirname(files[0] ?? target)), 'ledger.ndjson')));
mkdirSync(dirname(ledger), { recursive: true });
const caseMeta = loadCaseMeta(files);

const kaneVersion = sh([KANE, '--version']).stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown';
log(`redline · kane-cli ${kaneVersion} · ${files.length} case(s) · target ${targetName} ${url} · cap ${maxCredits} credits`);
log(`ledger → ${ledger}`);

let spent = 0;
const finals = [];
for (const file of files) {
  const meta = { id: basename(file).match(/^[A-Z]+\d+/)?.[0] ?? basename(file), ...(caseMeta[basename(file)] ?? {}) };
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (spent >= maxCredits) { log(`credit cap reached (${spent.toFixed(2)} ≥ ${maxCredits}), stopping`); finish(2); }
    const r = await runCase(file, attempt);
    spent += r.credits_spent ?? r.credits_reported ?? 0;
    attempts.push(r.triage);
    const line = {
      ts: new Date().toISOString(), case: meta.id, invariant: meta.invariant ?? null,
      file: relativeToRoot(file), sha256: sha(file), target: targetName, url, kane_version: kaneVersion,
      attempt, ...r,
    };
    appendFileSync(ledger, JSON.stringify(line) + '\n');
    log(`  ${line.case} #${attempt}: ${r.triage}  rc=${r.result_code ?? '-'} ${r.reason_code ?? ''}  credits=${fmt(r.credits_spent ?? r.credits_reported)}  ${r.duration_s}s`);
    if (r.triage === 'infra' || r.triage === 'infra_credits') {
      log(`  infra failure: ${r.reason ?? r.stderr_tail ?? 'no result'} — stopping, nothing is blamed on the app`);
      finals.push({ case: line.case, final: r.triage });
      appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), case: line.case, invariant: line.invariant, target: targetName, final: r.triage, attempts: [...attempts] }) + '\n');
      finish(2);
    }
    if (r.triage === 'held') break;
  }
  const final = settle(attempts[0], attempts[1]);
  finals.push({ case: meta.id, final, why: meta.why });
  appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), case: meta.id,
    invariant: meta.invariant ?? null, target: targetName, final, attempts }) + '\n');
}
finish(finals.some((f) => f.final === 'exploit_confirmed') ? 1
  : finals.every((f) => f.final === 'held') ? 0 : 3);

// ---------------------------------------------------------------------------

async function runCase(file, attempt) {
  const before = balance();
  const t0 = Date.now();
  const events = [];
  let stderr = '';
  const code = await new Promise((res) => {
    const p = spawn(KANE, ['testmd', 'run', file, '--agent', '--headless', '--url', url],
      { cwd: dirname(file), env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!raw) continue;
        try {
          const e = JSON.parse(raw); events.push(e);
          if (e.type == null && e.status === 'done' && e.remark) process.stderr.write(`    · ${String(e.remark).slice(0, 110)}\n`);
        } catch { /* non-JSON line: ignore */ }
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
    const m = sh([KANE, 'balance']).stdout.match(/Available credits:\s*([\d.]+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

function sh([bin, ...args]) {
  const r = spawnSync(bin, args, { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

function findRedlineRoot(start) {
  let d = start;
  while (d !== dirname(d)) { if (basename(d) === '.redline') return d; if (existsSync(join(d, '.redline'))) return join(d, '.redline'); d = dirname(d); }
  return join(start, '.redline');
}
function relativeToRoot(file) { const root = dirname(findRedlineRoot(dirname(file))); return file.startsWith(root) ? file.slice(root.length + 1) : file; }
function loadCaseMeta(fs) {
  const out = {};
  for (const dir of new Set(fs.map((f) => dirname(f)))) {
    const p = join(dir, 'cases.json');
    if (existsSync(p)) for (const c of JSON.parse(readFileSync(p, 'utf8'))) out[c.file] = c;
  }
  return out;
}
function sha(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function fmt(n) { return n == null ? '?' : Number(n).toFixed(2); }
function log(m) { process.stderr.write(m + '\n'); }
function finish(code) {
  log('\nresult');
  for (const f of finals) log(`  ${f.case.padEnd(5)} ${f.final}`);
  log(`credits spent this run: ${spent.toFixed(2)}`);
  process.exit(code);
}
