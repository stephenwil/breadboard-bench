// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/model.js';

const errors = (d) => M.analyze(d).checks.filter((c) => c.level === 'error');
const netOf = (A, ref) => { const [part, pin] = ref.split('.'); return A.nets.find((n) => n.pins.some((p) => p.part === part && p.name === pin)); };
const joined = (d, a, b) => { const A = M.analyze(d); return !!netOf(A, a) && netOf(A, a) === netOf(A, b); };
const base = () => {
  const d = M.newDesign({ name: 't' });
  M.placePart(d, { type: 'mb102-power', at: '1', props: { top: '5V', bottom: '3V3' } });
  M.placePart(d, { type: 'esp32-s3-devkitc-1', at: 'b8', props: { power: '5v-pin' } });
  M.placePart(d, { type: 'bme280-3v3', at: 'f40' });
  return d;
};

test('two endpoints add one wire with the net colour', () => {
  const d = base();
  const r = M.routeNets(d, { nets: [['U2.SDA', 'U1.GPIO8']] });
  assert.equal(r.wires.length, 1);
  assert.equal(r.wires[0].color, 'blue');
  assert.ok(joined(d, 'U2.SDA', 'U1.GPIO8'));
});

test('three pins skip what is already connected', () => {
  const d = base();
  M.addWire(d, { from: 'U2.VCC', to: 'B+' });
  const r = M.routeNets(d, { nets: [['U2.VCC', 'U2.CSB', 'B+']] });
  assert.equal(r.wires.length, 1);
  assert.ok(joined(d, 'U2.VCC', 'U2.CSB'));
});

test('running it twice adds nothing', () => {
  const d = base();
  M.routeNets(d, { nets: [['U2.SDA', 'U1.GPIO8']] });
  const again = M.routeNets(d, { nets: [['U2.SDA', 'U1.GPIO8']] });
  assert.equal(again.wires.length, 0);
  assert.deepEqual(again.satisfied, [['U2.SDA', 'U1.GPIO8']]);
});

test('a bad group is found before any wire is added', () => {
  const d = base();
  const before = d.wires.length;
  assert.throws(() => M.routeNets(d, { nets: [['U2.SDA', 'U1.GPIO8'], ['U2.SCL', 'U9.X']] }), /Net 2: .*No part called U9/);
  assert.equal(d.wires.length, before);
  assert.throws(() => M.routeNets(d, { nets: [['U2.SDA']] }), /Net 1 needs at least two endpoints/);
});

test('a taken explicit hole is refused', () => {
  const d = base();
  M.addWire(d, { from: 'a50', to: 'a52' });
  assert.throws(() => M.routeNets(d, { nets: [['a50', 'U2.VCC']] }), /Net 1: Hole a50 is taken/);
});

test('a full strip gives a clear error', () => {
  const d = base();
  for (const [from, to] of [['g40', 'a55'], ['h40', 'a56'], ['i40', 'a57'], ['j40', 'a58']]) M.addWire(d, { from, to });
  assert.throws(() => M.routeNets(d, { nets: [['U2.VCC', 'U1.GPIO8']] }), /No free hole left for U2\.VCC/);
});

test('no nets and no power is an error', () => {
  assert.throws(() => M.routeNets(base(), {}), /Give at least one net, or set power to true/);
});

test('joining two supplies is done and then flagged', () => {
  const d = M.newDesign();
  M.placePart(d, { type: 'esp32-s3-devkitc-1', at: 'b8' });
  const r = M.routeNets(d, { nets: [['U1.5V', 'U1.3V3']] });
  assert.equal(r.wires.length, 1);
  assert.ok(M.analyze(d).checks.some((c) => c.code === 'supply-clash'));
});

test('a straight wire is cheaper than its length', () => {
  const d = M.newDesign();
  assert.equal(M.scoreWire(d, 'a10', 'a14'), 4 + M.ROUTE_WEIGHTS.straight);
  assert.ok(Math.abs(M.scoreWire(d, 'a10', 'b14') - Math.hypot(4, 1)) < 1e-9);
});

test('a wire over a dev board costs per hole', () => {
  const d = M.newDesign();
  M.placePart(d, { type: 'esp32-s3-devkitc-1', at: 'a8' });
  assert.equal(M.scoreWire(d, 'T+10', 'B+10') - M.scoreWire(d, 'T+6', 'B+6'), 7 * M.ROUTE_WEIGHTS.overPart);
});

test('a crossing wire costs extra', () => {
  const d = M.newDesign();
  M.addWire(d, { from: 'T+15', to: 'c15' });
  assert.equal(M.scoreWire(d, 'a10', 'a20') - M.scoreWire(d, 'c10', 'c20'), M.ROUTE_WEIGHTS.crossing);
});

const resistorScene = () => {
  const d = M.newDesign();
  M.placePart(d, { type: 'resistor', at: 'e10', to: 'e12' });
  M.placePart(d, { type: 'resistor', at: 'e20', to: 'e22' });
  M.addWire(d, { from: 'T+15', to: 'c15' });
  return d;
};

test('the router picks the uncrossed hole', () => {
  const d = resistorScene();
  const r = M.routeNets(d, { nets: [['R1.1', 'R2.1']] });
  assert.equal(r.wires.length, 1);
  assert.deepEqual([r.wires[0].from, r.wires[0].to].sort(), ['c10', 'c20']);
});

test('the same input gives the same wires', () => {
  const a = M.routeNets(structuredClone(resistorScene()), { nets: [['R1.1', 'R2.1']] });
  const b = M.routeNets(structuredClone(resistorScene()), { nets: [['R1.1', 'R2.1']] });
  assert.equal(JSON.stringify(a.wires), JSON.stringify(b.wires));
});

const i2c = [['U2.SDA', 'U1.GPIO8'], ['U2.SCL', 'U1.GPIO9']];

test('power mode wires S3 + BME280 + MB102 cleanly', () => {
  const d = base();
  M.routeNets(d, { nets: i2c, power: true });
  assert.deepEqual(errors(d), []);
  assert.equal(netOf(M.analyze(d), 'U2.VCC').volts, 3.3);
  assert.equal(netOf(M.analyze(d), 'U1.5V').volts, 5);
});

test('a USB ESP32 feeds a rail', () => {
  const d = M.newDesign();
  M.placePart(d, { type: 'esp32-s3-devkitc-1', at: 'b8' });
  M.placePart(d, { type: 'bme280-3v3', at: 'f40' });
  const r = M.routeNets(d, { nets: i2c, power: true });
  assert.deepEqual(errors(d), []);
  assert.ok(r.notes.some((n) => /^fed .+ from U1\.3V3$/.test(n)), r.notes.join('; '));
});

test('no fitting voltage is explained', () => {
  const d = M.newDesign();
  M.placePart(d, { type: 'mb102-power', at: '1', props: { top: '5V', bottom: 'off' } });
  M.placePart(d, { type: 'bme280-3v3', at: 'f40' });
  assert.throws(() => M.routeNets(d, { power: true }), /No supply fits U1\.VCC \(1\.71-3\.6 V\)\. Available: 5 V\./);
  const bare = M.newDesign();
  M.placePart(bare, { type: 'bme280-3v3', at: 'f40' });
  assert.throws(() => M.routeNets(bare, { power: true }), /Nothing here supplies power/);
});

test('split rails: power lands on the powered half', () => {
  const d = M.newDesign({ splitRails: true });
  M.placePart(d, { type: 'mb102-power', at: '1', props: { top: '3V3', bottom: '3V3' } });
  M.placePart(d, { type: 'bme280-3v3', at: 'f50' });
  const r = M.routeNets(d, { power: true });
  const rail = r.wires.flatMap((w) => [w.from, w.to]).filter((h) => /^[TB][+-]/.test(h));
  assert.ok(rail.length >= 2);
  assert.ok(rail.every((h) => +h.slice(2) <= 32), rail.join(','));
});

test('joined boards with USB power have no errors', () => {
  const d = M.newDesign({ boards: 2 });
  M.placePart(d, { type: 'esp32-s3-devkitc-1', at: 'd5' });
  M.placePart(d, { type: 'bme280-3v3', at: '2:g40' });
  M.routeNets(d, { nets: i2c, power: true });
  assert.deepEqual(errors(d), []);
});
