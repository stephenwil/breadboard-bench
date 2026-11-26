#!/usr/bin/env node
// Breadboard Bench MCP server: Claude edits a breadboard design through MCP tools over stdio,
// and you watch and edit it in a browser. stdout belongs to MCP, so logging goes to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as M from './model.js';
import * as store from './designs.js';
import * as R from './render.js';

const DESIGNS_DIR = process.env.BREADBOARD_DESIGNS_DIR || path.join(os.homedir(), '.breadboard-bench', 'designs');
// One design file per Claude Code session (see designPathFor); BREADBOARD_DESIGN overrides it.
const { file: DESIGN_PATH, kind: DESIGN_KIND } = store.designPathFor(process.env, os.homedir());
const DESIGN_LABEL = store.designLabel(DESIGN_PATH, DESIGN_KIND);
// Before the rename the default lived under ~/.breadboard-mcp; read it if the new file doesn't exist yet.
const LEGACY_DESIGN_PATH = path.join(os.homedir(), '.breadboard-mcp', 'design.json');
const HOST = process.env.BREADBOARD_HOST || '127.0.0.1';
const PORT = Number(process.env.BREADBOARD_PORT || 5178);
const HISTORY = 100;
const log = (...a) => console.error('[breadboard-bench]', ...a);

// ---------- state ----------
let seen = null;
// Hash of the design file's content as this server last read or wrote it, to spot another process changing
// it underneath us. Content rather than modification time, so a same-size write in the same instant is seen
// and a touch (a sync or backup tool) is not. null when the file doesn't exist.
const hash = (text) => crypto.createHash('sha1').update(text).digest('hex');
const stamp = () => { try { return hash(fs.readFileSync(DESIGN_PATH)); } catch { return null; } };
let design = load(); // after hash, which load() uses
let rev = 1, viewUrl = null;
const undoStack = [], redoStack = [];
const userEdits = []; let userEditsSeen = 0; // edits made in the browser, for get_user_edits
const clients = new Set();

function load() {
  let file = DESIGN_PATH;
  if (DESIGN_KIND === 'shared' && !fs.existsSync(DESIGN_PATH) && fs.existsSync(LEGACY_DESIGN_PATH)) {
    file = LEGACY_DESIGN_PATH;
    log('no design at', DESIGN_PATH, '- loading', LEGACY_DESIGN_PATH);
  }
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (file === DESIGN_PATH) seen = hash(text);
    return M.normalizeDesign(JSON.parse(text));
  }
  catch (e) {
    if (e.code !== 'ENOENT') log('could not load', file, '- starting with an empty design:', e.message);
    return M.newDesign({ name: 'Untitled' });
  }
}
function persist() {
  fs.mkdirSync(path.dirname(DESIGN_PATH), { recursive: true });
  const tmp = `${DESIGN_PATH}.${process.pid}.tmp`;
  const text = JSON.stringify(design, null, 2);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, DESIGN_PATH);
  seen = hash(text); // what we wrote, so a replacement landing right after the rename still differs
}
const view = () => ({ ...M.buildView(design, { rev, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 }), file: DESIGN_LABEL });
function broadcast() { const msg = `data: ${JSON.stringify(view())}\n\n`; for (const res of clients) res.write(msg); }
function commit() { rev++; persist(); broadcast(); }

// Apply an edit to a copy; only a successful edit replaces the design and joins the undo history.
// Replace the design with the file's contents. The history described the old design, so it is cleared.
function reloadFromDisk() {
  let text;
  try { text = fs.readFileSync(DESIGN_PATH, 'utf8'); design = M.normalizeDesign(JSON.parse(text)); }
  catch { return false; /* half-written or deleted */ }
  undoStack.length = 0; redoStack.length = 0;
  seen = hash(text); rev++; broadcast();
  return true;
}
// Refuse to edit a design that another process has changed since we last looked; nothing is overwritten.
function guardExternal() {
  const now = stamp();
  if (now === null || now === seen) return;
  if (reloadFromDisk()) throw new M.ModelError(`Another session changed this design (now ${design.parts.length} parts, ${design.wires.length} wires). Check it with get_design and repeat your edit.`);
  // The repeat the message asks for would overwrite the broken file, so keep a copy of it first.
  try { fs.copyFileSync(DESIGN_PATH, `${DESIGN_PATH}.bad-${Date.now()}`); } catch { /* gone already */ }
  seen = now;
  throw new M.ModelError('Another session changed this design. Check it with get_design and repeat your edit.');
}

function mutate(fn, { label, by = 'claude' } = {}) {
  guardExternal();
  const before = design;
  const draft = structuredClone(design);
  const result = fn(draft);
  undoStack.push({ design: before, label, by });
  if (undoStack.length > HISTORY) undoStack.shift();
  redoStack.length = 0;
  design = draft;
  if (by === 'user' && label) userEdits.push({ at: new Date().toISOString(), what: label });
  commit();
  return result;
}
function undo(by) {
  guardExternal();
  const step = undoStack.pop();
  if (!step) throw new M.ModelError('Nothing to undo.');
  redoStack.push({ design, label: step.label, by: step.by });
  design = step.design;
  if (by === 'user') userEdits.push({ at: new Date().toISOString(), what: `undid "${step.label}"` });
  commit();
  return step.label;
}
function redo(by) {
  guardExternal();
  const step = redoStack.pop();
  if (!step) throw new M.ModelError('Nothing to redo.');
  undoStack.push({ design, label: step.label, by: step.by });
  design = step.design;
  if (by === 'user') userEdits.push({ at: new Date().toISOString(), what: `redid "${step.label}"` });
  commit();
  return step.label;
}

// Another process (Claude Code and Claude Desktop can both run this server) may change the file. Our own
// writes record their stamp in `seen`, so anything else that differs is external. The interval is only
// overridden (BREADBOARD_WATCH_MS) by tests that want the guard to be the one that notices.
fs.watchFile(DESIGN_PATH, { interval: Number(process.env.BREADBOARD_WATCH_MS) || 800 }, () => {
  if (stamp() === seen) return;
  if (reloadFromDisk()) log('reloaded design from disk');
});

// ---------- edits from the browser ----------
function userOp(op) {
  const by = 'user';
  switch (op.op) {
    case 'move_part': return mutate((d) => M.movePart(d, op), { by, label: `moved ${op.id}${op.at ? ` to ${op.at}` : ''}${op.rotation !== undefined ? ` (rotation ${op.rotation})` : ''}` });
    case 'remove_part': return mutate((d) => M.removePart(d, op), { by, label: `removed ${op.id}` });
    case 'set_part_props': return mutate((d) => M.setPartProps(d, op), { by, label: `set ${op.id} ${Object.entries(op.props || {}).map(([k, v]) => `${k}=${v}`).join(', ')}` });
    case 'add_wire': { const w = mutate((d) => M.addWire(d, op), { by, label: `added a wire ${op.from} → ${op.to}` }); return w; }
    case 'move_wire_end': return mutate((d) => M.moveWireEnd(d, op), { by, label: `moved the ${op.end} end of ${op.id} to ${op.to}` });
    case 'set_wire_color': return mutate((d) => M.setWireColor(d, op), { by, label: `made ${op.id} ${op.color}` });
    case 'remove_wire': return mutate((d) => M.removeWire(d, op), { by, label: `removed wire ${op.id}` });
    case 'route_power': {
      // Dry run first so a button press with nothing to do doesn't add an empty undo step.
      const probe = M.routeNets(structuredClone(design), { power: true });
      if (!probe.wires.length) return { added: 0, notes: probe.notes };
      const r = mutate((d) => M.routeNets(d, { power: true }), { by, label: 'routed power' });
      return { added: r.wires.length, notes: r.notes };
    }
    case 'route_net': {
      const refs = Array.isArray(op.refs) ? op.refs.map(String) : [];
      // Dry run first, as for route_power; it also reports a bad endpoint before anything changes.
      const probe = M.routeNets(structuredClone(design), { nets: [refs] });
      if (!probe.wires.length) return { added: 0, notes: probe.notes };
      const r = mutate((d) => M.routeNets(d, { nets: [refs] }), { by, label: `routed ${refs.join(', ')}` });
      return { added: r.wires.length, notes: r.notes };
    }
    case 'open_design': {
      const next = store.openDesign(DESIGNS_DIR, String(op.name || ''));
      mutate((draft) => { Object.keys(draft).forEach((k) => delete draft[k]); Object.assign(draft, next); }, { by, label: `opened "${next.name}"` });
      return { name: next.name, parts: next.parts.length, wires: next.wires.length };
    }
    case 'save_design': {
      const as = String(op.name || design.name || 'Untitled').trim() || 'Untitled';
      const file = store.saveDesign(DESIGNS_DIR, as, design);
      return { name: M.designFileName(as), title: design.name, file };
    }
    case 'load_design': {
      const next = M.normalizeDesign(op.design);
      mutate((draft) => { Object.keys(draft).forEach((k) => delete draft[k]); Object.assign(draft, next); }, { by, label: `loaded cart "${next.name}"` });
      return { name: next.name, parts: next.parts.length, wires: next.wires.length };
    }
    case 'undo': return undo(by);
    case 'redo': return redo(by);
    default: throw new M.ModelError(`Unknown edit "${op.op}".`);
  }
}

// ---------- browser viewer ----------
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url));
const cartJs = fs.readFileSync(new URL('./cart.js', import.meta.url));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); };
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'GET' && url.pathname === '/cart.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(cartJs);
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(200, view());
  if (req.method === 'GET' && url.pathname === '/api/designs') return json(200, { folder: DESIGNS_DIR, designs: store.listDesigns(DESIGNS_DIR) });
  if (req.method === 'GET' && url.pathname === '/api/design.json') {
    const slug = M.designFileName(design.name || 'design');
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (url.searchParams.get('download') === '1') headers['content-disposition'] = `attachment; filename="${slug}.bb.json"`;
    res.writeHead(200, headers);
    return res.end(JSON.stringify(design, null, 2));
  }
  if (req.method === 'GET' && (url.pathname === '/api/preview.svg' || url.pathname === '/api/preview.png')) {
    const q = url.searchParams;
    const opts = {
      boardColor: q.get('board') || 'cream',
      tidy: q.get('tidy') === '1' || q.get('tidy') === 'true',
      showChecks: q.get('checks') !== '0' && q.get('checks') !== 'false',
      showLabels: q.get('labels') !== '0' && q.get('labels') !== 'false',
      showWireIds: q.get('wire_ids') === '1' || q.get('wire_ids') === 'true',
      header: q.get('header') !== '0' && q.get('header') !== 'false',
      scale: q.get('scale') ? Number(q.get('scale')) : 1.5,
    };
    const slug = M.designFileName(design.name || 'design');
    if (url.pathname.endsWith('.svg')) {
      const headers = { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' };
      if (q.get('download') === '1') headers['content-disposition'] = `attachment; filename="${slug}.svg"`;
      res.writeHead(200, headers);
      return res.end(R.renderSvg(design, opts).svg);
    }
    const headers = { 'content-type': 'image/png', 'cache-control': 'no-store' };
    if (q.get('download') === '1') headers['content-disposition'] = `attachment; filename="${slug}.bb.png"`;
    res.writeHead(200, headers);
    return res.end(R.renderPng(design, opts).buffer);
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(view())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/op') {
    // Only accept same-origin JSON so other web pages can't drive the board.
    if (!String(req.headers['content-type'] || '').startsWith('application/json') || req.headers['x-breadboard'] !== '1') return json(403, { ok: false, error: 'Forbidden' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { const result = userOp(JSON.parse(body)); json(200, { ok: true, result }); }
      catch (e) { json(200, { ok: false, error: e instanceof M.ModelError ? e.message : 'That edit failed.' }); if (!(e instanceof M.ModelError)) log(e); }
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();
function listen(port, triesLeft) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) return listen(port + 1, triesLeft - 1);
    log('viewer could not start:', e.message);
  });
  server.listen(port, HOST);
}
// One listener, not one per listen() call: a failed attempt's callback would otherwise fire when a later port binds.
server.once('listening', () => { viewUrl = `http://${HOST === '0.0.0.0' ? os.hostname() : HOST}:${server.address().port}/`; log('viewer at', viewUrl); });
listen(PORT, 10);

// ---------- MCP tools ----------
const mcp = new McpServer(
  { name: 'breadboard-bench', version: '0.3.0' },
  {
    instructions:
      'Breadboard Bench lets you design, wire, verify, and visually inspect realistic breadboard circuits. ' +
      'Recommended workflow: (1) Call board_info and list_parts first and only use parts available in the library. ' +
      '(2) Start with new_design (use boards: 2 joined when an ESP32 DevKitC needs both headers reachable). ' +
      '(3) Place parts with clear spatial zones, wire power and grounds using standard color coding (5V=red, 3.3V=orange, GND=black), then wire signals. ' +
      '(4) Verify with check_design and get_nets (pass connected_only: true on large boards) — fix all errors and inspect warnings. ' +
      '(5) Visually inspect the layout with render_preview (PNG), critique component spacing, crossings, and readability, run a polish pass (move_part, set_wire_color, remove_wire/remove_wires, add_wires/route_nets), and re-verify before save_design.',
  },
);
const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const pendingEdits = () => userEdits.length - userEditsSeen;
const tool = (name, title, description, inputSchema, fn) =>
  mcp.registerTool(name, { title, description, inputSchema }, async (args) => {
    try {
      let out = await fn(args || {});
      const hasEdits = name !== 'get_user_edits' && pendingEdits() > 0;
      const note = hasEdits ? `${pendingEdits()} edit(s) made by the user in the viewer since you last looked; call get_user_edits.` : null;
      if (out && typeof out === 'object' && Array.isArray(out.content)) {
        return note ? { ...out, content: [...out.content, { type: 'text', text: note }] } : out;
      }
      if (note) out = typeof out === 'string' ? `${out}\n\n${note}` : { ...out, user_edits: note };
      return text(out);
    } catch (e) { return { isError: true, ...text(e instanceof M.ModelError ? e.message : `Error: ${e.message}`) }; }
  });
const status = () => M.summarizeChecks(M.analyze(design));
const viewerLine = () => `${viewUrl ? `Viewer: ${viewUrl}` : 'The viewer is not running.'}\nDesign file: ${DESIGN_LABEL}`;
const rotation = z.union([z.literal(0), z.literal(180)]);

tool('board_info', 'Board geometry and notation',
  'How holes, rails, boards and connections are named, and layout tips for wide dev boards. Read this before your first layout.',
  {}, () => M.boardInfo(design));

tool('list_parts', 'List part library', 'Every part type you can place, with pins, placement rules and props.', {}, () => M.listParts());

tool('new_design', 'Start a new design',
  'Replace the current design with empty breadboard(s). Use boards: 2 (joined) when an ESP32 DevKitC needs both headers reachable; that pair has a top rail pair on board 1 and a bottom pair on board 2. The old design can be restored with undo.',
  {
    name: z.string().optional(),
    size: z.enum(['half', 'full']).optional().describe('half = 30 columns, full = 63 (default)'),
    boards: z.union([z.literal(1), z.literal(2)]).optional().describe('1 (default) or 2 stacked boards'),
    joined: z.boolean().optional().describe('With 2 boards: true (default) = pushed together with the facing rails removed; false = two separate boards with all rails'),
    split_rails: z.boolean().optional().describe('True if the rails are broken in the middle'),
  },
  (a) => {
    const next = M.newDesign({ name: a.name || 'Untitled', size: a.size || 'full', boards: a.boards || 1, joined: a.joined !== false, splitRails: a.split_rails });
    mutate((draft) => { Object.keys(draft).forEach((k) => delete draft[k]); Object.assign(draft, next); }, { label: 'new design' });
    return { started: design.name, boards: M.describeBoards(design), viewer: viewUrl };
  });

tool('place_part', 'Place a part',
  'Put a part on the board. `at` is the anchor hole (see list_parts). Fails with a reason if a pin would hit a taken hole or the part doesn\'t fit.',
  { type: z.string(), at: z.string(), id: z.string().optional(), rotation: rotation.optional(), to: z.string().optional().describe('Second lead, for two-lead parts'), props: z.record(z.string(), z.any()).optional() },
  (a) => {
    const part = mutate((d) => M.placePart(d, a), { label: `place ${a.type}` });
    const L = M.analyze(design).layout.find((x) => x.part.id === part.id);
    const body = M.describeBody(L, design);
    return { placed: part.id, pins: L.pins.map((p) => `${p.key} ${p.name} @ ${p.hole}`), ...(L.covered.length ? { covers: `${L.covered.length} holes under the board` } : {}), ...(body ? { body } : {}), status: status() };
  });
tool('move_part', 'Move a part', 'Move or rotate a placed part. Returns the new pin holes and body clearance. Existing wires stay in their old holes, so check connections afterwards.',
  { id: z.string(), at: z.string().optional(), rotation: rotation.optional(), to: z.string().optional() },
  (a) => {
    const p = mutate((d) => M.movePart(d, a), { label: `move ${a.id}` });
    const L = M.analyze(design).layout.find((x) => x.part.id === p.id);
    const body = M.describeBody(L, design);
    return { moved: p.id, at: p.at, ...(p.to ? { to: p.to } : {}), rotation: p.rotation, pins: L.pins.map((x) => `${x.key} ${x.name} @ ${x.hole}`), ...(body ? { body } : {}), status: status() };
  });
tool('set_part_props', 'Change part settings', 'Change props such as the ESP32 power mode, resistor ohms, LED color, breakout pin order, or power module jumpers.',
  { id: z.string(), props: z.record(z.string(), z.any()) },
  (a) => { const p = mutate((d) => M.setPartProps(d, a), { label: `set ${a.id} props` }); return `${p.id} props: ${JSON.stringify(p.props)}. ${status()}.`; });
tool('remove_part', 'Remove a part', 'Remove a part. Wires stay where they are.',
  { id: z.string() }, (a) => { mutate((d) => M.removePart(d, a), { label: `remove ${a.id}` }); return `Removed ${a.id}. ${status()}.`; });

tool('add_wires', 'Add jumper wires',
  'Add wires in order. Each end is a hole (a12, T+5, 2:b7), a rail (T+, 2:B-; nearest free hole) or a part pin (U1.GPIO8, U2.SDA, D1.A; a free hole in that pin\'s strip). Colour follows the net if omitted. All-or-nothing.',
  { wires: z.array(z.object({ from: z.string(), to: z.string(), color: z.enum(M.WIRE_COLORS).optional() })).min(1) },
  ({ wires }) => {
    const added = mutate((d) => wires.map((w, i) => {
      try { return M.addWire(d, w); } catch (e) { throw new M.ModelError(`Wire ${i + 1} (${w.from} → ${w.to}): ${e.message} No wires were added.`); }
    }), { label: `add ${wires.length} wire${wires.length > 1 ? 's' : ''}` });
    return { added: added.map((w) => `${w.id}: ${w.via[0]} (${w.from}) → ${w.via[1]} (${w.to}), ${w.color}`), status: status() };
  });
tool('move_wire_end', 'Move a wire end', 'Move one end of a wire to another hole.',
  { id: z.string(), end: z.enum(['from', 'to']), to: z.string() },
  (a) => { const w = mutate((d) => M.moveWireEnd(d, a), { label: `move ${a.id}` }); return `${w.id} now ${w.from} → ${w.to}. ${status()}.`; });
tool('set_wire_color', 'Change wire color', 'Change the insulation color of an existing wire without removing it (e.g. standardize GND=black, 5V=red, 3.3V=orange, SDA=blue, SCL=yellow).',
  { id: z.string(), color: z.enum(M.WIRE_COLORS) },
  (a) => { const w = mutate((d) => M.setWireColor(d, a), { label: `recolor ${a.id} to ${a.color}` }); return `${w.id} is now ${w.color} (${w.from} → ${w.to}). ${status()}.`; });
tool('remove_wire', 'Remove a wire', 'Remove a wire by id (W3).',
  { id: z.string() }, (a) => { mutate((d) => M.removeWire(d, a), { label: `remove ${a.id}` }); return `Removed ${a.id}. ${status()}.`; });
tool('remove_wires', 'Remove multiple wires', 'Remove multiple wires by id in a single atomic, undoable step (all-or-nothing), e.g. { ids: ["W3", "W7", "W9"] }.',
  { ids: z.array(z.string()).min(1) },
  ({ ids }) => {
    const removed = mutate((d) => M.removeWires(d, ids), { label: `remove ${ids.length} wire${ids.length === 1 ? '' : 's'}` });
    return `Removed ${removed.join(', ')}. ${status()}.`;
  });
tool('route_nets', 'Route nets',
  'Let the tool choose the wires. `nets` is a list of groups of endpoints that must end up as one net, e.g. [["U1.GPIO8","U2.SDA"],["U2.VCC","U2.CSB","B+"]]. Endpoints are a hole (used exactly), a rail (T+, 2:B-) or a part pin (U1.GPIO8); a rail or pin lets the tool pick a free hole. It adds the fewest wires, skips pins that are already connected, and prefers short, straight wires that avoid crossing parts and other wires. In a group with a rail, each pin is wired to the rail rather than chained to another pin. `power: true` also wires every ground pin and supply pin to the nearest fitting rail (energizing and bridging multiple rail pairs on 2-board layouts when parts span both boards or when rails are referenced in `nets`, feeding from a USB-powered ESP32 if no rail is powered). One undo reverts the whole route; use add_wires when you want to choose each hole yourself.',
  { nets: z.array(z.array(z.string())).optional(), power: z.boolean().optional() },
  ({ nets = [], power = false }) => {
    const r = mutate((d) => M.routeNets(d, { nets, power }), { label: `route ${nets.length} net${nets.length === 1 ? '' : 's'}${power ? ' + power' : ''}` });
    // Wire ends are free holes in a pin's strip, so name the pins that share the hole's strip.
    const inStrip = new Map();
    for (const L of M.analyze(design).layout) for (const p of L.pins) {
      const st = M.stripOf(M.parseHole(p.hole, design), design);
      inStrip.set(st, [...(inStrip.get(st) || []), `${L.part.id}.${p.name}`]);
    }
    const at = (h) => { const names = inStrip.get(M.stripOf(M.parseHole(h, design), design)); return names ? `${h} (${names.join(', ')})` : h; };
    return { added: r.wires.map((w) => `${w.id}: ${at(w.from)} → ${at(w.to)}, ${w.color}`), already_connected: r.satisfied, notes: r.notes, status: status() };
  });

tool('undo', 'Undo', 'Undo the last change, whether you or the user made it.', {}, () => `Undid "${undo('claude')}". ${status()}.`);
tool('redo', 'Redo', 'Redo the last undone change.', {}, () => `Redid "${redo('claude')}". ${status()}.`);

tool('get_user_edits', 'Edits made in the viewer',
  'Changes the user made by hand in the browser since you last called this. Re-read the design after acting on them.',
  {}, () => {
    const fresh = userEdits.slice(userEditsSeen);
    userEditsSeen = userEdits.length;
    return fresh.length ? { edits: fresh, status: status() } : 'No edits from the viewer since you last checked.';
  });
tool('get_design', 'Read the design', 'Boards, parts with every pin\'s hole and net, wires, and a check summary.',
  {}, () => ({ ...M.describeDesign(design), viewer: viewUrl }));
tool('get_nets', 'List nets',
  'Every net: which pins, strips and wires it joins, and its voltage if it is a supply. Pass connected_only: true to hide single-part unconnected pins (useful on large dev boards).',
  { connected_only: z.boolean().optional().describe('If true, omit nets with no wires that only touch a single part (default: false)') },
  (a) => M.describeNets(design, { connectedOnly: !!a.connected_only }));
tool('check_design', 'Check the design',
  'Physical fit, overlapping bodies, dangling wires, shorts, supply voltages, common ground, I²C wiring and addresses, UART wiring, LED resistors, floating passives/buttons, risky GPIOs, power wire color-coding, and layout neatness metrics. Fix every error before calling a layout done.',
  {}, () => {
    const a = M.analyze(design);
    const fmtCheck = (c) => `${c.level.toUpperCase()} [${c.code}] ${c.message}${c.holes?.length ? ` (holes: ${c.holes.join(', ')})` : ''}`;
    return {
      summary: M.summarizeChecks(a),
      checks: a.checks.map(fmtCheck),
      layout: M.layoutMetrics(design, a),
      i2c: a.firmware.map(({ mcu, sda, scl, devices }) => ({ mcu, sda, scl, devices: devices.map(({ part, kind, address }) => ({ part, kind, address })) })),
    };
  });
tool('render_preview', 'Render visual preview',
  'Render the current breadboard layout headlessly as a PNG image (returned natively as an MCP image for visual inspection) or SVG. Use this to inspect component spacing, wire crossings, readability, and highlighted checks, and optionally save the preview to disk via output_path.',
  {
    format: z.enum(['png', 'svg']).optional().describe('Output format: png (default, native MCP image) or svg'),
    board_color: z.enum(R.BOARD_COLORS).optional().describe('Breadboard palette: cream (default), white, green, blue, red, black'),
    tidy: z.boolean().optional().describe('Draw wires with 90-degree orthogonal bends and lane separation instead of curves (default: false)'),
    show_checks: z.boolean().optional().describe('Highlight error/warning holes on the board and show a check footer (default: true)'),
    show_labels: z.boolean().optional().describe('Show part IDs and resistor ohm labels on two-lead components (default: true)'),
    show_wire_ids: z.boolean().optional().describe('Badge wire midpoints with wire IDs (W1, W2, ...) for targeted cleanup (default: false)'),
    header: z.boolean().optional().describe('Include header bar with title, counts, and check status (default: true)'),
    scale: z.number().min(0.5).max(3).optional().describe('PNG scale factor 0.5–3 (default: 1.5)'),
    output_path: z.string().optional().describe('Optional file path to save the rendered PNG or SVG to disk'),
  },
  (a) => {
    const opts = {
      boardColor: a.board_color || 'cream',
      tidy: !!a.tidy,
      showChecks: a.show_checks !== false,
      showLabels: a.show_labels !== false,
      showWireIds: !!a.show_wire_ids,
      header: a.header !== false,
      scale: a.scale ?? 1.5,
    };
    const saveFile = (buf) => {
      if (!a.output_path) return null;
      const target = path.resolve(a.output_path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      return target;
    };
    if (a.format === 'svg') {
      const out = R.renderSvg(design, opts);
      const saved = saveFile(out.svg);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ format: 'svg', width: out.width, height: out.height, ...(saved ? { saved_to: saved } : {}), status: out.summary, layout: out.metrics }, null, 2) },
          { type: 'text', text: out.svg },
        ],
      };
    }
    const out = R.renderPng(design, opts);
    const saved = saveFile(out.buffer);
    return {
      content: [
        { type: 'image', mimeType: 'image/png', data: out.buffer.toString('base64') },
        { type: 'text', text: JSON.stringify({ format: 'png', width: out.width, height: out.height, ...(saved ? { saved_to: saved } : {}), status: out.summary, layout: out.metrics }, null, 2) },
      ],
    };
  });
tool('get_viewer_url', 'Viewer link', 'The URL where the user can watch and edit the board.', {}, () => viewerLine());
tool('load_design', 'Load a design', 'Replace the design with a design object (the saved file format). Undo restores the previous one.',
  { design: z.record(z.string(), z.any()) },
  ({ design: d }) => { const next = M.normalizeDesign(d); mutate((draft) => { Object.keys(draft).forEach((k) => delete draft[k]); Object.assign(draft, next); }, { label: 'load design' }); return `Loaded "${design.name}". ${status()}.`; });

tool('save_design', 'Save the design by name',
  'Save the current design as a named file so it can be opened later, for example before new_design or open_design replaces it. Saving under a name that already exists overwrites that file. Defaults to the design\'s own name.',
  { name: z.string().optional() },
  ({ name }) => { const as = name || design.name, file = store.saveDesign(DESIGNS_DIR, as, design); return `Saved "${as}" to ${file}.`; });
tool('list_designs', 'List saved designs', 'Designs saved with save_design, newest first, with board, part and wire counts.',
  {}, () => { const designs = store.listDesigns(DESIGNS_DIR); return designs.length ? { folder: DESIGNS_DIR, designs } : `No saved designs in ${DESIGNS_DIR}.`; });
tool('open_design', 'Open a saved design',
  'Replace the current design with a saved one. Undo restores the previous one, but save the current design first if you want to keep it after a restart.',
  { name: z.string() },
  ({ name }) => { const next = store.openDesign(DESIGNS_DIR, name); mutate((draft) => { Object.keys(draft).forEach((k) => delete draft[k]); Object.assign(draft, next); }, { label: `open ${name}` }); return `Opened "${design.name}". ${status()}.`; });

// ---------- MCP prompts ----------
mcp.registerPrompt(
  'design-circuit',
  {
    title: 'Design a breadboard circuit end-to-end',
    description: 'Guided workflow to plan, place, wire, verify, visually inspect, polish, and save a breadboard circuit.',
    argsSchema: {
      goal: z.string().describe('The circuit to design (e.g. "ESP32-S3 with BME280, OLED, button, and status LEDs")'),
      board_setup: z.string().optional().describe('Optional board preference (e.g. "two joined full boards", "single full board with MB102")'),
    },
  },
  ({ goal, board_setup }) => ({
    description: `End-to-end breadboard circuit design workflow for: ${goal}`,
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Design and build the following breadboard circuit using the breadboard-bench MCP tools:`,
          `Goal: ${goal}`,
          ...(board_setup ? [`Board preference: ${board_setup}`] : []),
          ``,
          `Follow this workflow step by step:`,
          `1. **Discover capabilities**: Call \`board_info\` and \`list_parts\`. Only use part types that genuinely exist in \`list_parts\`, and respect every placement rule, voltage limit, and pinout.`,
          `2. **Choose board geometry**: Call \`new_design\` with a descriptive name. Use \`boards: 2, joined: true\` if an ESP32 DevKitC needs pins on both headers reachable (anchor J1/J2 in row d or e of board 1, rotation 0). Use a single board if using an \`mb102-power\` rail module.`,
          `3. **Plan spatial zones before placing**: Give parts breathing room so wires do not have to cross over dev boards or sensor PCBs. Put upright single-header breakouts so their PCB body clears neighboring parts and routing channels. Choose clean GPIOs (avoid flash/PSRAM, strapping, native USB, UART0, and onboard RGB LED pins).`,
          `4. **Place parts & wire power first**: Place all parts with \`place_part\`, then establish clean power & ground rails (using \`route_nets({ power: true })\` or explicit \`add_wires\`). Follow standard color coding: GND = black, 5V = red, 3.3V = orange, I²C SDA = blue, SCL = yellow, UART TX = white, RX = purple.`,
          `5. **Wire signals**: Connect I²C, UART, LEDs (always with 220–1000 Ω series resistors), and buttons cleanly using \`route_nets\` or \`add_wires\`.`,
          `6. **Electrical verification**: Call \`check_design\` and \`get_nets({ connected_only: true })\`. Fix every ERROR and address WARNINGs (floating leads, dangling wires, risky GPIOs, overlapping bodies, missing resistors).`,
          `7. **Visual inspection & polish (v1 → v2)**: Call \`render_preview\` (with \`show_wire_ids: true\` if helpful) to inspect the layout visually. Critique component spacing, wire crossings, wires crossing over parts, and color coding. Execute a polish pass to improve neatness, then re-run \`check_design\` and \`render_preview\`.`,
          `8. **Save & summarize**: Call \`save_design\` and \`get_viewer_url\`, then report the circuit architecture, pin/firmware mapping (e.g. Wire.begin / Serial1.begin / GPIO assignments), and verification results.`,
        ].join('\n'),
      },
    }],
  }),
);

mcp.registerPrompt(
  'layout-polish-pass',
  {
    title: 'Visual & routing polish pass',
    description: 'Critique and refine an existing breadboard layout for wiring neatness, spacing, color coding, and visual clarity.',
    argsSchema: {
      focus: z.string().optional().describe('Optional area to focus cleanup on (e.g. "reduce crossings", "power rail colors", "component grouping")'),
    },
  },
  ({ focus }) => ({
    description: 'Visual and routing polish pass for the current breadboard design.',
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Run a thorough layout and wiring polish pass on the current breadboard design.`,
          ...(focus ? [`Focus area: ${focus}`] : []),
          ``,
          `Steps:`,
          `1. **Baseline audit**: Call \`get_design\`, \`check_design\`, and \`render_preview({ show_wire_ids: true })\` to inspect both layout metrics (\`wireCrossings\`, \`wiresOverParts\`, \`totalWireLength\`, \`powerColorMismatches\`) and the actual rendered board.`,
          `2. **Visual critique**: Identify concrete improvements:`,
          `   - Wires crossing over dev boards, sensor bodies, or other wires.`,
          `   - Long diagonal runs that can be shortened by moving a part closer to its target GPIOs or switching to a nearer rail.`,
          `   - Crowded components or colliding labels/bodies.`,
          `   - Non-standard wire colors on power/ground/bus nets (GND=black, 5V=red, 3.3V=orange, SDA=blue, SCL=yellow).`,
          `3. **Apply cleanups**: Use \`move_part\`, \`remove_wire\` / \`remove_wires\`, \`add_wires\`, \`move_wire_end\`, \`set_wire_color\`, and \`route_nets\` to simplify routing. Remember \`move_part\` leaves existing wires in their old holes — clean up or re-route those wires immediately.`,
          `4. **Verify**: Re-run \`check_design\` (confirm 0 errors, no dangling wires, improved layout metrics) and \`render_preview\` (both curved and optionally \`tidy: true\`) to visually confirm the improvement.`,
        ].join('\n'),
      },
    }],
  }),
);

mcp.registerPrompt(
  'debug-circuit',
  {
    title: 'Debug breadboard circuit issues',
    description: 'Diagnose and fix electrical, physical, or firmware-mapping issues in the current breadboard design.',
    argsSchema: {
      symptom: z.string().optional().describe('Optional symptom, failing check, or unexpected behavior to investigate'),
    },
  },
  ({ symptom }) => ({
    description: 'Systematic debugging workflow for the current breadboard design.',
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Diagnose and fix problems in the current breadboard design.`,
          ...(symptom ? [`Reported symptom: ${symptom}`] : []),
          ``,
          `Steps:`,
          `1. Call \`check_design\`, \`get_nets({ connected_only: true })\`, and \`render_preview({ show_checks: true, show_wire_ids: true })\` to inspect all flagged holes and net connectivity.`,
          `2. Triage issues in priority order:`,
          `   - **Physical fit**: \`hole-clash\`, \`under-board\`, \`strip-short\`, \`body-overlap\`, \`under-psu\`.`,
          `   - **Power & ground**: \`short\`, \`supply-clash\`, \`overvoltage\`, \`undervoltage\`, \`unpowered\`, \`no-ground\`, \`split-ground\`, \`mcu-backfeed\`.`,
          `   - **Bus & GPIO integrity**: \`i2c-unconnected\`, \`i2c-short\`, \`csb-low\`, \`uart-crossed\`, \`uart-unconnected\`, \`gpio-error\`, \`gpio-warning\`.`,
          `   - **Passives & wiring hygiene**: \`led-backwards\`, \`led-no-resistor\`, \`led-resistor-low\`, \`resistor-open\`, \`button-open\`, \`dangling-wire\`.`,
          `3. Apply targeted fixes (prefer minimal edits; use \`undo\` if an edit makes things worse).`,
          `4. Re-run \`check_design\`, \`get_nets\`, and \`render_preview\` to confirm all issues are resolved.`,
        ].join('\n'),
      },
    }],
  }),
);

await mcp.connect(new StdioServerTransport());
log('MCP server ready; design file', DESIGN_PATH);
