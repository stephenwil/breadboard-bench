// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/mcp.js';

const ID = '0c1d338e-d098-4028';
const state = async (s) => (await fetch(`http://127.0.0.1:${s.port}/api/state`)).json();
const bb = (s) => path.join(s.home, '.breadboard-bench');

test('a session gets its own file, created on the first edit', async () => {
  const s = await startServer({ env: { CLAUDE_CODE_SESSION_ID: ID } });
  try {
    assert.equal(fs.existsSync(bb(s)), false);
    await s.call('new_design', {});
    assert.ok(fs.existsSync(path.join(bb(s), 'sessions', `${ID}.json`)));
    assert.equal(fs.existsSync(path.join(bb(s), 'design.json')), false);
    assert.match((await s.call('get_viewer_url')).text, /Design file: session 0c1d338e/);
    assert.equal((await state(s)).file, 'session 0c1d338e');
  } finally { await s.stop(); }
});

test('without a session id the shared file is used', async () => {
  const s = await startServer();
  try {
    await s.call('new_design', {});
    assert.ok(fs.existsSync(path.join(bb(s), 'design.json')));
    assert.equal((await state(s)).file, 'design.json');
  } finally { await s.stop(); }
});

test('BREADBOARD_DESIGN overrides the session file', async () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'bb-ov-'));
  const mine = path.join(home, 'mine.json');
  const s = await startServer({ home, env: { BREADBOARD_DESIGN: mine, CLAUDE_CODE_SESSION_ID: ID } });
  try {
    await s.call('new_design', {});
    assert.ok(fs.existsSync(mine));
    assert.equal(fs.existsSync(path.join(bb(s), 'sessions')), false);
    assert.equal((await state(s)).file, 'mine.json');
  } finally { await s.stop(); }
});

test('the legacy file is only read for the shared file', async () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'bb-leg-'));
  fs.mkdirSync(path.join(home, '.breadboard-mcp'), { recursive: true });
  fs.writeFileSync(path.join(home, '.breadboard-mcp', 'design.json'), JSON.stringify({ version: 2, name: 'Legacy', boards: [{ size: 'full', rails: 'both' }], parts: [], wires: [], nextWire: 1 }));
  const shared = await startServer({ home });
  const session = await startServer({ home, env: { CLAUDE_CODE_SESSION_ID: ID } });
  try {
    assert.equal((await state(shared)).name, 'Legacy');
    assert.equal((await state(session)).name, 'Untitled');
  } finally { await shared.stop(); await session.stop(); }
});
