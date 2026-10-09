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
