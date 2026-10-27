#!/usr/bin/env node
// Redline — Kane CLI as a red team inside the coding-agent loop.
//
//   redline run <case_test.md | dir> --url <app> [--target name] [--max-credits N] [--ledger path]
//   redline init --url <app> [--cases .redline/cases]     wire hooks into .claude/settings.json + lock
//   redline lock                                          re-lock after a human adds/changes cases
//   redline verify                                        check locked files against .redline/lock.json
//   redline hook pre-tool-use | stop                      Claude Code hook entry points (stdin JSON)
//
// run exit: 0 all held · 1 exploit confirmed · 2 halted (infra/credit cap) · 3 inconclusive/false positives

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCases } from '../src/run.mjs';
import { init, writeLock, verifyLock, preToolUseHook, stopHook } from '../src/guard.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const project = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

switch (argv[0]) {
  case 'run': {
    const url = opt('--url', process.env.REDLINE_APP_URL);
    if (!argv[1] || !url) usage();
    const r = await runCases({ target: argv[1], url, targetName: opt('--target', 'app'),
      maxCredits: Number(opt('--max-credits', '60')), ledger: opt('--ledger') });
    process.exit(r.code);
  }
  case 'init': {
    const url = opt('--url'); if (!url) usage();
    const r = init(project, { url, cases: opt('--cases', '.redline/cases'), binPath: fileURLToPath(import.meta.url) });
    console.log(`redline: hooks written to ${r.settings}\nredline: config ${r.config}\nredline: ${r.locked} file(s) locked in .redline/lock.json`);
    process.exit(0);
  }
  case 'lock': {
    const l = writeLock(project); console.log(`redline: ${Object.keys(l.files).length} file(s) locked`); process.exit(0);
  }
  case 'verify': {
    const v = verifyLock(project);
    console.log(v.ok ? 'redline: lock intact' : `redline: TAMPERED\n  ${v.problems.join('\n  ')}`);
    process.exit(v.ok ? 0 : 1);
  }
  case 'hook': {
    const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const proj = resolve(process.env.CLAUDE_PROJECT_DIR ?? payload.cwd ?? process.cwd());
    if (argv[1] === 'pre-tool-use') {
      const r = preToolUseHook(proj, payload);
      if (r.stderr) process.stderr.write(r.stderr + '\n');
      process.exit(r.code);
    }
    if (argv[1] === 'stop') {
      const out = await stopHook(proj, payload);
      if (Object.keys(out).length) process.stdout.write(JSON.stringify(out) + '\n');
      process.exit(0);
    }
    usage();
  }
  default: usage();
}

function usage() {
  console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(64);
}
