import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tamperCheck } from '../src/guard.mjs';

const P = '/repo';
const bash = (command) => tamperCheck(P, 'Bash', { command });
const write = (file_path, tool = 'Write') => tamperCheck(P, tool, { file_path });

test('writes to locked paths are blocked, app code is not', () => {
  assert.ok(write('/repo/.redline/cases/INV-01/C01_test.md'));
  assert.ok(write('.redline/lock.json', 'Edit'));
  assert.ok(write('src/foo_test.md', 'MultiEdit'));
  assert.ok(write('.claude/settings.json'));
  assert.ok(write('/elsewhere/.redline/x'));
  assert.equal(write('src/lib/sizing.ts', 'Edit'), null);
});

test('shell writes to locked files are blocked', () => {
  for (const c of ['sed -i s/a/b/ .redline/cases/x_test.md', 'echo x > .redline/lock.json', 'rm .redline/cases/x_test.md',
    'mv .redline /tmp', 'git checkout -- .redline', 'cat a | tee .redline/x', 'python3 fix.py .redline/cases',
    'find .redline -delete', 'cp evil_test.md .redline/cases/']) assert.ok(bash(c), c);
});

test('reading locked files and running the gate are allowed', () => {
  for (const c of ['cat .redline/cases/INV-01/C01_test.md', 'grep -r size .redline/cases | head', 'git diff -- .redline',
    'node ~/kane-redline/bin/redline.mjs run .redline/cases --url http://localhost:5176', 'npm run dev']) assert.equal(bash(c), null, c);
});
