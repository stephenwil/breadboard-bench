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

// Two servers on one file. The file watcher is slowed to an hour (BREADBOARD_WATCH_MS) unless a test asks
// for it, so the guard alone has to catch the change and the tests don't depend on a poll tick.
const pair = async ({ watch = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'bb-pair-'));
  const file = path.join(dir, 'shared.json');
  const env = { BREADBOARD_DESIGN: file, ...(watch ? {} : { BREADBOARD_WATCH_MS: '3600000' }) };
  const a = await startServer({ env }), b = await startServer({ env });
  return { a, b, file, stop: async () => { await a.stop(); await b.stop(); } };
};
const parts = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).parts.length;
const BME = { type: 'bme280-3v3', at: 'f40' }, S3 = { type: 'esp32-s3-devkitc-1', at: 'b8' };
const COUNTED = /^Another session changed this design \(now 1 parts, 0 wires\)\. Check it with get_design and repeat your edit\.$/;
const UNREADABLE = /^Another session changed this design\. Check it with get_design and repeat your edit\.$/;

test('an edit is refused after another server changed the file', async () => {
  const p = await pair();
  try {
    assert.equal((await p.b.call('place_part', BME)).isError, false);
    const before = fs.readFileSync(p.file, 'utf8');
    const r = await p.a.call('place_part', S3);
    assert.equal(r.isError, true);
    assert.match(r.text, COUNTED);
    assert.equal(fs.readFileSync(p.file, 'utf8'), before);
    assert.match((await p.a.call('get_design')).text, /bme280-3v3/);
    assert.equal((await p.a.call('place_part', S3)).isError, false);
    assert.equal(parts(p.file), 2);
  } finally { await p.stop(); }
});

test('the browser gets the same refusal', async () => {
  const p = await pair();
  try {
    await p.b.call('place_part', BME);
    const r = await fetch(`http://127.0.0.1:${p.a.port}/api/op`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-breadboard': '1' }, body: JSON.stringify({ op: 'remove_part', id: 'U1' }) });
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.match(j.error, /^Another session changed this design/);
    assert.equal(parts(p.file), 1);
  } finally { await p.stop(); }
});

test('undo is also guarded', async () => {
  const p = await pair();
  try {
    await p.b.call('place_part', BME);
    const r = await p.a.call('undo');
    assert.equal(r.isError, true);
    assert.match(r.text, COUNTED);
  } finally { await p.stop(); }
});

test('a deleted file is not a conflict', async () => {
  const p = await pair();
  try {
    await p.a.call('place_part', S3);
    fs.unlinkSync(p.file);
    assert.equal((await p.a.call('place_part', BME)).isError, false);
    assert.ok(fs.existsSync(p.file));
  } finally { await p.stop(); }
});

test('an unreadable file refuses once, without counts', async () => {
  const p = await pair();
  try {
    await p.a.call('place_part', S3);
    fs.writeFileSync(p.file, '{ not json');
    const r = await p.a.call('place_part', BME);
    assert.equal(r.isError, true);
    assert.match(r.text, UNREADABLE);
    assert.match((await p.a.call('get_design')).text, /esp32-s3-devkitc-1/);
    const backup = fs.readdirSync(path.dirname(p.file)).find((f) => f.startsWith('shared.json.bad-'));
    assert.ok(backup, 'the unreadable file should be kept before a repeat can overwrite it');
    assert.equal(fs.readFileSync(path.join(path.dirname(p.file), backup), 'utf8'), '{ not json');
    assert.equal((await p.a.call('place_part', BME)).isError, false);
    assert.equal(parts(p.file), 2);
  } finally { await p.stop(); }
});

test('an external write right after our own is still picked up by the watcher', async () => {
  const p = await pair({ watch: true });
  try {
    await p.a.call('place_part', S3);
    const d = JSON.parse(fs.readFileSync(p.file, 'utf8'));
    fs.writeFileSync(p.file, JSON.stringify({ ...d, name: 'External' }, null, 2));
    let name;
    for (let i = 0; i < 40 && name !== 'External'; i++) { await new Promise((r) => setTimeout(r, 100)); name = (await state(p.a)).name; }
    assert.equal(name, 'External');
  } finally { await p.stop(); }
});

test('an external reload clears the undo history', async () => {
  const p = await pair();
  try {
    await p.a.call('place_part', S3);
    const d = JSON.parse(fs.readFileSync(p.file, 'utf8'));
    fs.writeFileSync(p.file, JSON.stringify({ ...d, name: 'External' }, null, 2));
    assert.match((await p.a.call('place_part', BME)).text, COUNTED);
    const r = await p.a.call('undo');
    assert.equal(r.isError, true);
    assert.match(r.text, /Nothing to undo/);
  } finally { await p.stop(); }
});
