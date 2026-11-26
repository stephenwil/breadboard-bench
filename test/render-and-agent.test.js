// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as M from '../src/model.js';
import * as R from '../src/render.js';
import { startServer } from './helpers/mcp.js';

const codes = (d) => M.analyze(d).checks.map((c) => `${c.level}:${c.code}`);

// ---------- model checks & layout metrics ----------
test('new checks: dangling wires, floating resistors/buttons, and body overlap', () => {
  const d = M.newDesign({ name: 'Checks' });
  M.placePart(d, { type: 'resistor', at: 'a10', to: 'a14', props: { ohms: 220 } });
  M.placePart(d, { type: 'button', at: 'e20' });
  M.addWire(d, { from: 'a30', to: 'a35' });
  // Two single-header breakouts placed close enough that upright bodies collide
  M.placePart(d, { type: 'bme280-3v3', at: 'c45' });
  M.placePart(d, { type: 'ssd1306-oled', at: 'b46' });

  const c = codes(d);
  assert.ok(c.includes('warning:resistor-open'), c.join(', '));
  assert.ok(c.includes('warning:button-open'), c.join(', '));
  assert.ok(c.includes('warning:dangling-wire'), c.join(', '));
  assert.ok(c.includes('warning:body-overlap'), c.join(', '));
});

test('new checks: series-resistor LED backwards, low/high ohm warnings, and universal GPIO checks', () => {
  const d = M.newDesign({ boards: 2 });
  M.placePart(d, { type: 'esp32-s3-devkitc-1', at: 'd5' });
  // Backwards LED through a 10-ohm resistor wired to reserved octal-flash GPIO35
  M.placePart(d, { type: 'resistor', at: 'e40', to: 'e44', props: { ohms: 10 } });
  M.placePart(d, { type: 'led', at: 'd44', to: 'd46', props: { color: 'red' } });
  M.addWire(d, { from: 'R1.1', to: 'U1.GND' });
  M.addWire(d, { from: 'D1.K', to: 'U1.GPIO35' });

  const c = codes(d);
  assert.ok(c.includes('error:led-backwards'), c.join(', '));
  assert.ok(c.includes('warning:led-resistor-low'), c.join(', '));
  assert.ok(c.includes('error:gpio-error'), c.join(', '));

  // High resistor value warning
  M.setPartProps(d, { id: 'R1', props: { ohms: 47000 } });
  assert.ok(codes(d).includes('warning:led-resistor-high'));
});

test('new checks: power wire color-coding advisory and layoutMetrics', () => {
  const d = M.newDesign({ name: 'Metrics' });
  M.placePart(d, { type: 'mb102-power', at: '1', props: { top: '5V', bottom: '3V3' } });
  M.placePart(d, { type: 'bme280-3v3', at: 'f40' });
  M.addWire(d, { from: 'U1.GND', to: 'B-', color: 'yellow' }); // non-standard GND color
  M.addWire(d, { from: 'U1.VCC', to: 'B+', color: 'orange' });
  // Two crossing wires
  M.addWire(d, { from: 'a20', to: 'e26', color: 'green' });
  M.addWire(d, { from: 'e20', to: 'a26', color: 'blue' });

  assert.ok(codes(d).includes('info:wire-color'));
  const m = M.layoutMetrics(d);
  assert.equal(m.parts, 2);
  assert.equal(m.wires, 4);
  assert.equal(m.wireCrossings, 1);
  assert.equal(m.crossingPairs.length, 1);
  assert.equal(m.powerColorMismatches.length, 1);
  assert.equal(m.powerColorMismatches[0].expected, 'black');
});

test('power routing with no power pins returns a clear note', () => {
  const d = M.newDesign();
  const r = M.routeNets(d, { power: true });
  assert.equal(r.wires.length, 0);
  assert.ok(r.notes.some((n) => /No ground or supply pins/i.test(n)));
});

test('wiresOverParts detects wires crossing tactile buttons and upright breakout PCBs', () => {
  const d = M.newDesign({ name: 'BodyHits' });
  M.placePart(d, { type: 'button', at: 'e20' }); // body spans e-f, cols 20-22
  M.placePart(d, { type: 'bme280-3v3', at: 'e35' }); // body extends upward over c-d, cols 35-40
  const wBtn = M.addWire(d, { from: 'd21', to: 'g21' }); // cuts across SW1 body
  const wPcbHit = M.addWire(d, { from: 'c30', to: 'c45' }); // cuts through U1 upright PCB (rows c-d)
  const wPcbClear = M.addWire(d, { from: 'a35', to: 'T+35' }); // stays above U1 body (rows a-b clear)
  const m = M.layoutMetrics(d);
  assert.ok(m.wiresOverParts.includes(wBtn.id), m.wiresOverParts.join(', '));
  assert.ok(m.wiresOverParts.includes(wPcbHit.id), m.wiresOverParts.join(', '));
  assert.ok(!m.wiresOverParts.includes(wPcbClear.id), m.wiresOverParts.join(', '));
});

test('listParts single-header placement docs, describeBody, connectedOnly nets, and batch removeWires', () => {
  const parts = M.listParts();
  for (const type of ['bme280-3v3', 'ssd1306-oled', 'gps-neo6m']) {
    const entry = parts.find((p) => p.type === type);
    assert.match(entry.placement || '', /upward.*a–e.*downward.*f–j/i);
  }

  const d = M.newDesign({ boards: 2 });
  M.placePart(d, { type: 'esp32-s3-devkitc-1', at: 'e4' });
  M.placePart(d, { type: 'bme280-3v3', at: 'e30' });
  M.placePart(d, { type: 'resistor', at: '2:e40', to: '2:f40', props: { ohms: 330 } });
  M.placePart(d, { type: 'led', at: '2:g40', to: '2:g41' }); // shares strip 2:b40 with R1 without a wire
  const w1 = M.addWire(d, { from: 'U1.GPIO8', to: 'U2.SDA' });
  const w2 = M.addWire(d, { from: 'U1.GPIO9', to: 'U2.SCL' });

  const bmeL = M.analyze(d).layout.find((x) => x.part.id === 'U2');
  assert.match(M.describeBody(bmeL, d), /upward over rows c–d.*rows a, b stay clear/);

  const allNets = M.describeNets(d);
  const connNets = M.describeNets(d, { connectedOnly: true });
  assert.ok(allNets.length > 35, `expected many unconnected MCU nets, got ${allNets.length}`);
  assert.equal(connNets.length, 3); // SDA, SCL, and R1+D1 strip
  assert.ok(connNets.some((n) => n.pins.some((p) => p.startsWith('R1.')) && n.pins.some((p) => p.startsWith('D1.'))));

  // Batch removeWires: all-or-nothing on invalid id
  assert.throws(() => M.removeWires(d, [w1.id, 'W999']), /No wire called W999/);
  assert.equal(d.wires.length, 2);
  const removed = M.removeWires(d, [w1.id, w2.id]);
  assert.deepEqual(removed, [w1.id, w2.id]);
  assert.equal(d.wires.length, 0);
});

// ---------- headless renderer ----------
test('renderSvg and renderPng produce valid SVG and PNG across modes', () => {
  const d = M.newDesign({ name: 'Split Preview', splitRails: true });
  M.placePart(d, { type: 'mb102-power', at: '1', props: { top: '5V', bottom: '3V3' } });
  M.placePart(d, { type: 'resistor', at: 'e12', to: 'e16', props: { ohms: 330 } });
  M.placePart(d, { type: 'led', at: 'd16', to: 'd18', props: { color: 'blue' } });
  M.addWire(d, { from: 'R1.1', to: 'T+' });
  M.addWire(d, { from: 'D1.K', to: 'T-' });

  const svgOut = R.renderSvg(d, { boardColor: 'black', tidy: true, showWireIds: true });
  assert.match(svgOut.svg, /^<svg /);
  assert.match(svgOut.svg, /Split Preview/);
  assert.match(svgOut.svg, /R1 330Ω/);
  assert.match(svgOut.svg, /W1/);

  const pngOut = R.renderPng(d, { boardColor: 'cream', scale: 1 });
  assert.equal(pngOut.buffer.slice(0, 4).toString('hex'), '89504e47');
  assert.ok(pngOut.width > 500 && pngOut.height > 200);
});

// ---------- MCP server integration: render_preview, set_wire_color, remove_wires, get_nets, prompts, HTTP previews ----------
test('MCP server exposes render_preview, set_wire_color, remove_wires, get_nets filter, body info, and prompts', async () => {
  const s = await startServer();
  const tmpOut = path.join(os.tmpdir(), `bb-preview-test-${Date.now()}.png`);
  try {
    // Instructions advertised on initialize
    assert.match(s.client.getInstructions() || '', /render_preview/);

    // Prompts registered and readable
    const { prompts } = await s.client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    assert.deepEqual(names, ['debug-circuit', 'design-circuit', 'layout-polish-pass']);
    const p1 = await s.client.getPrompt({ name: 'design-circuit', arguments: { goal: 'Dual LED indicator' } });
    assert.ok(p1.messages.length >= 1);
    assert.match(p1.messages[0].content.text, /Dual LED indicator/);

    // Build a circuit and test place_part body info, move_part, set_wire_color, get_nets filter, remove_wires, check_design, render_preview
    await s.call('new_design', { name: 'Agent Test', size: 'half' });
    await s.call('place_part', { type: 'mb102-power', at: '1', props: { top: '5V', bottom: '3V3' } });
    const placedSensor = JSON.parse((await s.call('place_part', { type: 'bme280-3v3', at: 'f22' })).text);
    assert.match(placedSensor.body || '', /downward over rows g–h/);
    await s.call('place_part', { type: 'resistor', at: 'e12', to: 'e16', props: { ohms: 330 } });
    await s.call('place_part', { type: 'led', at: 'd16', to: 'd18', props: { color: 'green' } });
    await s.call('add_wires', { wires: [{ from: 'R1.1', to: 'T+', color: 'blue' }, { from: 'D1.K', to: 'T-', color: 'black' }] });

    // get_nets connected_only filters unconnected sensor pins
    const allNets = JSON.parse((await s.call('get_nets')).text);
    const connNets = JSON.parse((await s.call('get_nets', { connected_only: true })).text);
    assert.ok(connNets.length < allNets.length);
    assert.equal(connNets.length, 3); // 5V (R1.1+T+), GND (D1.K+T-), and R1+D1 strip

    // move_part returns updated pins and body info for breakouts
    const mv = await s.call('move_part', { id: 'D1', at: 'b16', to: 'b18' });
    assert.equal(mv.isError, false, mv.text);
    const mvData = JSON.parse(mv.text);
    assert.equal(mvData.moved, 'D1');
    assert.ok(mvData.pins.some((p) => p.includes('b16')));
    const mvSensor = JSON.parse((await s.call('move_part', { id: 'U1', at: 'e22' })).text);
    assert.match(mvSensor.body || '', /upward over rows c–d/);

    // check_design includes layout metrics and wire-color note before recolor
    const chk1 = JSON.parse((await s.call('check_design')).text);
    assert.ok(chk1.layout && typeof chk1.layout.wireCrossings === 'number');
    assert.ok(chk1.checks.some((line) => line.includes('[wire-color]')));

    // set_wire_color fixes it
    const rc = await s.call('set_wire_color', { id: 'W1', color: 'red' });
    assert.equal(rc.isError, false, rc.text);
    assert.match(rc.text, /W1 is now red/);
    const chk2 = JSON.parse((await s.call('check_design')).text);
    assert.equal(chk2.layout.powerColorMismatches.length, 0);

    // remove_wires removes both wires in one undoable step, and undo restores them
    const rmBatch = await s.call('remove_wires', { ids: ['W1', 'W2'] });
    assert.equal(rmBatch.isError, false, rmBatch.text);
    assert.equal(JSON.parse((await s.call('get_design')).text).wires.length, 0);
    await s.call('undo');
    assert.equal(JSON.parse((await s.call('get_design')).text).wires.length, 2);

    // render_preview returns native MCP PNG image + writes output_path
    const imgRes = await s.call('render_preview', { tidy: true, show_wire_ids: true, scale: 1, output_path: tmpOut });
    assert.equal(imgRes.isError, false, imgRes.text);
    const imgBlock = imgRes.content.find((c) => c.type === 'image');
    assert.ok(imgBlock, 'render_preview must return a native MCP image content block');
    assert.equal(imgBlock.mimeType, 'image/png');
    assert.equal(Buffer.from(imgBlock.data, 'base64').slice(0, 4).toString('hex'), '89504e47');
    assert.ok(fs.existsSync(tmpOut));

    // SVG mode works too
    const svgRes = await s.call('render_preview', { format: 'svg' });
    assert.equal(svgRes.isError, false);
    assert.match(svgRes.text, /<svg /);

    // HTTP preview endpoints work
    const pngHttp = await fetch(`http://127.0.0.1:${s.port}/api/preview.png?tidy=1&scale=1`);
    assert.equal(pngHttp.status, 200);
    assert.equal(pngHttp.headers.get('content-type'), 'image/png');
    const pngBuf = Buffer.from(await pngHttp.arrayBuffer());
    assert.equal(pngBuf.slice(0, 4).toString('hex'), '89504e47');

    const svgHttp = await fetch(`http://127.0.0.1:${s.port}/api/preview.svg`);
    assert.equal(svgHttp.status, 200);
    assert.match(await svgHttp.text(), /^<svg /);
  } finally {
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    await s.stop();
  }
});
