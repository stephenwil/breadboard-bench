// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';

const codes = (d) => M.analyze(d).checks.map((c) => `${c.level}:${c.code}`);
const errors = (d) => M.analyze(d).checks.filter((c) => c.level === 'error');

test('single board: S3 + BME280 + power module wires up cleanly', () => {
  const d = M.newDesign({ name: 't' });
  M.placePart(d, { type: 'mb102-power', at: '1', props: { top: '5V', bottom: '3V3' } });
  M.placePart(d, { type: 'esp32-s3-devkitc-1', at: 'b8', props: { power: '5v-pin' } });
  M.placePart(d, { type: 'bme280-3v3', at: 'f40' });
  for (const [from, to] of [['U1.5V', 'T+'], ['U1.GND', 'T-'], ['U2.VCC', 'B+'], ['U2.GND', 'B-'], ['T-', 'B-'], ['U2.SDA', 'U1.GPIO8'], ['U2.SCL', 'U1.GPIO9']]) M.addWire(d, { from, to });
  assert.deepEqual(errors(d), []);
  assert.ok(M.analyze(d).firmware.some((b) => b.sda === 8 && b.scl === 9));
});

test('single board: the far header of a DevKitC has no free holes', () => {
  const d = M.newDesign();
  M.placePart(d, { type: 'esp32-s3-devkitc-1', at: 'b8' });
  assert.throws(() => M.addWire(d, { from: 'U1.GPIO35', to: 'a50' }), /No free hole/);
});

test('joined pair: both headers reachable', () => {
  const d = M.newDesign({ boards: 2 });
  M.placePart(d, { type: 'esp32-s3-devkitc-1', at: 'd5' });
  const w = M.addWire(d, { from: 'U1.GPIO35', to: 'a50' });
  assert.match(w.from, /^2:/);
  assert.throws(() => M.placePart(d, { type: 'mb102-power', at: '1' }), /both rail pairs/);
});

test('3.3 V-only BME280 on 5 V is an error', () => {
  const d = M.newDesign();
  M.placePart(d, { type: 'mb102-power', at: '1', props: { top: '5V' } });
  M.placePart(d, { type: 'bme280-3v3', at: 'a40' });
  M.addWire(d, { from: 'U1.VCC', to: 'T+' });
  assert.ok(codes(d).includes('error:overvoltage'));
});

test('split grounds, shorts and backwards LEDs are caught', () => {
  const d = M.newDesign();
  M.placePart(d, { type: 'mb102-power', at: '1', props: { top: '5V', bottom: '3V3' } });
  assert.ok(codes(d).includes('error:split-ground'));
  M.addWire(d, { from: 'T+', to: 'T-' });
  assert.ok(codes(d).includes('error:short'));
  const e = M.newDesign();
  M.placePart(e, { type: 'mb102-power', at: '1', props: { top: '5V' } });
  M.placePart(e, { type: 'led', at: 'a30', to: 'a31' });
  M.addWire(e, { from: 'D1.A', to: 'T-' });
  M.addWire(e, { from: 'D1.K', to: 'T+' });
  assert.ok(codes(e).includes('error:led-backwards'));
});

test('strapping and reserved GPIOs are flagged', () => {
  const d = M.newDesign({ boards: 2 });
  M.placePart(d, { type: 'esp32-s3-devkitc-1', at: 'd5' });
  M.placePart(d, { type: 'bme280-3v3', at: 'a40' });
  M.addWire(d, { from: 'U2.VCC', to: 'U1.3V3' });
  M.addWire(d, { from: 'U2.GND', to: 'U1.GND' });
  M.addWire(d, { from: 'U2.SDA', to: 'U1.GPIO35' });
  M.addWire(d, { from: 'U2.SCL', to: 'U1.GPIO0' });
  const c = codes(d);
  assert.ok(c.includes('error:gpio-error'));
  assert.ok(c.includes('warning:gpio-warning'));
});

test('v1 design files still load', () => {
  const d = M.normalizeDesign({ version: 1, name: 'old', board: 'half', parts: [], wires: [] });
  assert.equal(d.boards.length, 1);
  assert.equal(M.boardLayout(d)[0].cols, 30);
});
