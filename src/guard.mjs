// Lock manifest, tamper guard (PreToolUse) and Stop gate for Claude Code.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { findCases, runCases, sha256 } from './run.mjs';

// ---------------------------------------------------------------- config / lock

export function loadConfig(project) {
  const p = join(project, '.redline', 'config.json');
  if (!existsSync(p)) throw new Error(`no .redline/config.json in ${project} (run: redline init --url <app>)`);
  return { cases: '.redline/cases', maxCredits: 40, loopBudget: 5, target: 'gate', ...JSON.parse(readFileSync(p, 'utf8')) };
}

function lockedFiles(project, cfg) {
  const files = findCases(join(project, cfg.cases));
  for (const extra of ['.redline/config.json', ...files.map((f) => f.replace(/[^/]+$/, 'cases.json'))]) {
    const abs = isAbsolute(extra) ? extra : join(project, extra);
    if (existsSync(abs) && !files.includes(abs)) files.push(abs);
  }
  return files.sort();
}

export function writeLock(project) {
  const cfg = loadConfig(project);
  const files = Object.fromEntries(lockedFiles(project, cfg).map((f) => [relative(project, f), sha256(f)]));
  const lock = { created: new Date().toISOString(), files };
  writeFileSync(join(project, '.redline', 'lock.json'), JSON.stringify(lock, null, 2) + '\n');
  return lock;
}

export function verifyLock(project) {
  const p = join(project, '.redline', 'lock.json');
  if (!existsSync(p)) return { ok: false, problems: ['.redline/lock.json is missing'] };
  const lock = JSON.parse(readFileSync(p, 'utf8'));
  const problems = [];
  for (const [rel, h] of Object.entries(lock.files)) {
    const abs = join(project, rel);
    if (!existsSync(abs)) problems.push(`${rel} was deleted`);
    else if (sha256(abs) !== h) problems.push(`${rel} was modified`);
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------- tamper guard

const PROTECTED = [/(^|\/)\.redline(\/|$)/, /_test\.md$/, /(^|\/)\.claude\/settings(\.local)?\.json$/];
const isProtectedPath = (rel) => PROTECTED.some((re) => re.test(rel.replace(/\\/g, '/')));
const MENTIONS = /\.redline|_test\.md|\.claude\/settings/;
const READ_ONLY = new Set(['cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'rg', 'jq', 'wc', 'ls', 'stat',
  'diff', 'sha256sum', 'md5sum', 'file', 'find', 'tree', 'echo']);

// Returns null if allowed, or a reason string if the call must be blocked.
export function tamperCheck(project, toolName, input) {
  const path = input?.file_path ?? input?.notebook_path ?? input?.path;
  if (path && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(toolName)) {
    const rel = relative(project, resolve(project, path));
    if (isProtectedPath(rel)) return `${rel} is locked by Redline`;
    return null;
  }
  if (toolName === 'Bash' && typeof input?.command === 'string' && MENTIONS.test(input.command)) {
    const c = input.command;
    if (/redline\.mjs\s+(run|verify)\b|\bredline\s+(run|verify)\b/.test(c) && !/[>;`]|\$\(|&&|\|\|/.test(c)) return null;
    if (/[>;`]|\$\(|&&|\|\||\s-i\b|--in-place|\btee\b|-delete\b|-exec\b/.test(c)) return 'shell command can write to locked Redline files';
    const bad = c.split('|').map((s) => s.trim().split(/\s+/)[0]).find((w) => !READ_ONLY.has(w) && w !== 'git');
    if (bad) return `"${bad}" on locked Redline files is not allowed (read-only commands only)`;
    if (/\bgit\b/.test(c) && !/\bgit\s+(diff|log|show|status|blame)\b/.test(c)) return 'git commands that can change locked Redline files are not allowed';
    return null;
  }
  return null;
}

export function preToolUseHook(project, payload) {
  let cfg = null; try { cfg = loadConfig(project); } catch { return { code: 0 }; } // not a Redline project
  const reason = tamperCheck(project, payload.tool_name, payload.tool_input);
  if (!reason) return { code: 0 };
  ledger(project, { type: 'tamper_blocked', tool: payload.tool_name,
    target: payload.tool_input?.file_path ?? payload.tool_input?.command ?? null, reason, session: payload.session_id ?? null });
  return { code: 2, stderr:
    `Redline blocked this: ${reason}. The tests under .redline/ are the referee and are locked; ` +
    `every attempt to change them is logged. If a locked case fails, fix the application code instead.` };
}

// ---------------------------------------------------------------- stop gate

export async function stopHook(project, payload) {
  let cfg; try { cfg = loadConfig(project); } catch { return {}; }
  const state = readState(project);

  const lock = verifyLock(project);
  if (!lock.ok) {
    ledger(project, { type: 'gate', decision: 'tamper_detected', problems: lock.problems });
    return { systemMessage: `Redline: locked files changed outside the guard (${lock.problems.join('; ')}). ` +
      'A human must restore them (git checkout -- .redline) before the gate can be trusted.' };
  }

  const fp = fingerprint(project);
  if (fp && state.greenFingerprint === fp) return {}; // nothing changed since the last green replay

  if (!(await reachable(cfg.url))) {
    return block(project, state, cfg, `The app is not reachable at ${cfg.url}. Start the dev server in the background ` +
      '(npm run dev) so Redline can replay the locked cases, then finish your turn.', 'app_down');
  }

  const lines = [];
  const r = await runCases({ target: join(project, cfg.cases), url: cfg.url, targetName: cfg.target,
    maxCredits: cfg.maxCredits, ledger: join(project, '.redline', 'ledger.ndjson'), log: (m) => lines.push(m) });
  process.stderr.write(lines.join('\n') + '\n');
  const held = r.finals.filter((f) => f.final === 'held').length;

  if (r.code === 0) {
    writeState(project, { greenFingerprint: fp, blocks: 0 });
    ledger(project, { type: 'gate', decision: 'allow', held, total: r.finals.length, credits: r.spent });
    return { systemMessage: `Redline: ${held}/${r.finals.length} locked cases held (${r.spent.toFixed(2)} credits).` };
  }
  if (r.code === 1) {
    const broken = r.finals.filter((f) => f.final === 'exploit_confirmed');
    const brief = broken.map((f) =>
      `- ${f.case}: ${f.title ?? ''}\n  Expected: ${JSON.stringify(f.expect ?? {})}\n  Kane: ${f.one_liner ?? f.reason ?? 'assertion failed'}\n  Case (read-only): ${relative(project, f.file)}`).join('\n');
    return block(project, state, cfg,
      `Redline: ${broken.length} locked case(s) now fail in a real browser (reproduced twice by Kane CLI):\n${brief}\n\n` +
      'Fix the application code so these cases hold again. Do not edit anything under .redline/ — those files are locked.',
      'regression', { broken: broken.map((f) => f.case), credits: r.spent });
  }
  ledger(project, { type: 'gate', decision: 'allow_unverified', code: r.code, finals: r.finals.map((f) => [f.case, f.final]) });
  return { systemMessage: `Redline could not verify this turn (${r.code === 2 ? 'infra problem or credit cap' : 'inconclusive runs'}): ` +
    r.finals.filter((f) => f.final !== 'held').map((f) => `${f.case}=${f.final}`).join(', ') + '. Nothing was blamed on the agent; check .redline/ledger.ndjson.' };
}

function block(project, state, cfg, reason, kind, extra = {}) {
  const blocks = (state.blocks ?? 0) + 1;
  if (blocks > cfg.loopBudget) {
    writeState(project, { ...state, blocks: 0 });
    ledger(project, { type: 'gate', decision: 'escalate', kind, blocks: blocks - 1, ...extra });
    return { systemMessage: `Redline: still failing after ${cfg.loopBudget} blocked stops (${kind}). Escalating to you; see .redline/ledger.ndjson.` };
  }
  writeState(project, { ...state, blocks });
  ledger(project, { type: 'gate', decision: 'block', kind, attempt: blocks, ...extra });
  return { decision: 'block', reason };
}

// ---------------------------------------------------------------- init

export function init(project, { url, cases = '.redline/cases', binPath }) {
  mkdirSync(join(project, '.redline'), { recursive: true });
  const cfgPath = join(project, '.redline', 'config.json');
  const prev = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
  writeFileSync(cfgPath, JSON.stringify({ ...prev, url, cases, maxCredits: prev.maxCredits ?? 40, loopBudget: prev.loopBudget ?? 5, target: prev.target ?? 'gate' }, null, 2) + '\n');

  const sPath = join(project, '.claude', 'settings.json');
  mkdirSync(join(project, '.claude'), { recursive: true });
  const s = existsSync(sPath) ? JSON.parse(readFileSync(sPath, 'utf8')) : {};
  s.hooks ??= {};
  const cmd = (h) => `node "${binPath}" hook ${h}`;
  const strip = (arr) => (arr ?? []).filter((g) => !JSON.stringify(g).includes('hook pre-tool-use') && !JSON.stringify(g).includes('hook stop'));
  s.hooks.PreToolUse = [...strip(s.hooks.PreToolUse),
    { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: cmd('pre-tool-use'), timeout: 30 }] }];
  s.hooks.Stop = [...strip(s.hooks.Stop), { hooks: [{ type: 'command', command: cmd('stop'), timeout: 1200 }] }];
  writeFileSync(sPath, JSON.stringify(s, null, 2) + '\n');

  const md = join(project, 'CLAUDE.md');
  const block = `\n<!-- redline -->\n## Redline\n\nThis repo is guarded by Redline. The cases under \`.redline/\` are adversarial browser tests run by Kane CLI; they are locked.\n- You cannot edit, move or delete anything under \`.redline/\` or any \`*_test.md\`. Attempts are blocked and logged.\n- When you finish a turn, Redline replays every locked case in a real browser. If one fails, your turn is blocked with a brief; fix the application code, not the test.\n- Keep the dev server running at ${url} while you work.\n<!-- /redline -->\n`;
  const cur = existsSync(md) ? readFileSync(md, 'utf8') : '';
  if (!cur.includes('<!-- redline -->')) writeFileSync(md, cur + block);

  const lock = writeLock(project);
  return { config: cfgPath, settings: sPath, locked: Object.keys(lock.files).length };
}

// ---------------------------------------------------------------- helpers

function ledger(project, o) {
  try { appendFileSync(join(project, '.redline', 'ledger.ndjson'), JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n'); } catch { /* best effort */ }
}
function readState(project) {
  try { return JSON.parse(readFileSync(join(project, '.redline', 'state.json'), 'utf8')); } catch { return {}; }
}
function writeState(project, st) { writeFileSync(join(project, '.redline', 'state.json'), JSON.stringify(st) + '\n'); }

function fingerprint(project) {
  const run = (a) => spawnSync('git', a, { cwd: project, encoding: 'utf8' });
  const st = run(['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).redline']);
  if (st.status !== 0) return null;
  const diff = run(['diff', 'HEAD', '--', '.', ':(exclude).redline']).stdout ?? '';
  return createHash('sha256').update(st.stdout + '\n' + diff).digest('hex');
}

async function reachable(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); return r.status < 500; } catch { return false; }
}
