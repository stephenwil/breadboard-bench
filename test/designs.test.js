// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as M from '../src/model.js';
import * as store from '../src/designs.js';

const tmpDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-designs-')), 'designs');

test('designFileName makes a safe lowercase name', () => {
  assert.equal(M.designFileName('ESP32-S3 + BME280'), 'esp32-s3-bme280');
  assert.equal(M.designFileName('  My Board  '), 'my-board');
  assert.equal(M.designFileName('a_b-c'), 'a_b-c');
});

test('designFileName rejects empty names and path tricks', () => {
  assert.throws(() => M.designFileName(''), /name/i);
  assert.throws(() => M.designFileName('   '), /name/i);
  assert.throws(() => M.designFileName('...'), /name/i);
  assert.equal(M.designFileName('../../etc/passwd'), 'etc-passwd');
  assert.equal(M.designFileName('a/b\\c'), 'a-b-c');
});

test('save creates the folder and writes a loadable file', () => {
  const dir = tmpDir();
  const d = M.newDesign({ name: 'Blinky' });
  M.placePart(d, { type: 'led', at: 'a10', to: 'a12' });
  const file = store.saveDesign(dir, 'Blinky', d);
  assert.equal(path.basename(file), 'blinky.json');
  const back = store.openDesign(dir, 'blinky');
  assert.equal(back.name, 'Blinky');
  assert.equal(back.parts.length, 1);
});

test('save overwrites a design with the same name', () => {
  const dir = tmpDir();
  store.saveDesign(dir, 'x', M.newDesign({ name: 'one' }));
  store.saveDesign(dir, 'x', M.newDesign({ name: 'two' }));
  assert.equal(store.openDesign(dir, 'x').name, 'two');
  assert.equal(store.listDesigns(dir).length, 1);
});

test('list returns saved designs with a summary, newest first', () => {
  const dir = tmpDir();
  const a = M.newDesign({ name: 'A' });
  const b = M.newDesign({ name: 'B', boards: 2 });
  M.placePart(b, { type: 'led', at: 'a10', to: 'a12' });
  store.saveDesign(dir, 'a', a);
  const older = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(dir, 'a.json'), older, older);
  store.saveDesign(dir, 'b', b);
  const list = store.listDesigns(dir);
  assert.deepEqual(list.map((x) => x.name), ['b', 'a']);
  assert.equal(list[0].boards, 2);
  assert.equal(list[0].parts, 1);
  assert.equal(list[1].parts, 0);
  assert.ok(list[0].modified);
});

test('list is empty when the folder does not exist, and skips other files', () => {
  const dir = tmpDir();
  assert.deepEqual(store.listDesigns(dir), []);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi');
  fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
  assert.deepEqual(store.listDesigns(dir), []);
});

test('open reports a missing design and suggests the saved ones', () => {
  const dir = tmpDir();
  store.saveDesign(dir, 'blinky', M.newDesign({ name: 'Blinky' }));
  assert.throws(() => store.openDesign(dir, 'nope'), (e) => e instanceof M.ModelError && /No saved design "nope"/.test(e.message) && /blinky/.test(e.message));
});

test('open reports a file that is not valid JSON', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
  assert.throws(() => store.openDesign(dir, 'bad'), (e) => e instanceof M.ModelError && /bad/.test(e.message));
});

test('a name with path tricks stays inside the folder', () => {
  const dir = tmpDir();
  const file = store.saveDesign(dir, '../../escape', M.newDesign());
  assert.equal(path.dirname(file), dir);
});
