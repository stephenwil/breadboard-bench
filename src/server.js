#!/usr/bin/env node
// Breadboard MCP server: Claude edits a breadboard design through MCP tools over stdio,
// and you watch and edit it in a browser. stdout belongs to MCP, so logging goes to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as M from './model.js';

const DESIGN_PATH = process.env.BREADBOARD_DESIGN || path.join(os.homedir(), '.breadboard-mcp', 'design.json');
const HOST = process.env.BREADBOARD_HOST || '127.0.0.1';
const PORT = Number(process.env.BREADBOARD_PORT || 5178);
const HISTORY = 100;
const log = (...a) => console.error('[breadboard]', ...a);

// ---------- state ----------
let design = load();
let rev = 1, lastWrite = 0, viewUrl = null;
const undoStack = [], redoStack = [];
const userEdits = []; let userEditsSeen = 0; // edits made in the browser, for get_user_edits
const clients = new Set();

function load() {
  try { return M.normalizeDesign(JSON.parse(fs.readFileSync(DESIGN_PATH, 'utf8'))); }
  catch { return M.newDesign({ name: 'Untitled' }); }
}
function persist() {
  fs.mkdirSync(path.dirname(DESIGN_PATH), { recursive: true });
  const tmp = DESIGN_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(design, null, 2));
  fs.renameSync(tmp, DESIGN_PATH);
  lastWrite = Date.now();
}
const view = () => M.buildView(design, { rev, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
function broadcast() { const msg = `data: ${JSON.stringify(view())}\n\n`; for (const res of clients) res.write(msg); }
function commit() { rev++; persist(); broadcast(); }

// Apply an edit to a copy; only a successful edit replaces the design and joins the undo history.
function mutate(fn, { label, by = 'claude' } = {}) {
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
  const step = undoStack.pop();
  if (!step) throw new M.ModelError('Nothing to undo.');
  redoStack.push({ design, label: step.label, by: step.by });
  design = step.design;
  if (by === 'user') userEdits.push({ at: new Date().toISOString(), what: `undid "${step.label}"` });
  commit();
  return step.label;
}
function redo(by) {
  const step = redoStack.pop();
  if (!step) throw new M.ModelError('Nothing to redo.');
  undoStack.push({ design, label: step.label, by: step.by });
  design = step.design;
  if (by === 'user') userEdits.push({ at: new Date().toISOString(), what: `redid "${step.label}"` });
  commit();
  return step.label;
}

// Another process (Claude Code and Claude Desktop can both run this server) may change the file.
fs.watchFile(DESIGN_PATH, { interval: 800 }, () => {
  if (Date.now() - lastWrite < 1500) return;
  try { design = M.normalizeDesign(JSON.parse(fs.readFileSync(DESIGN_PATH, 'utf8'))); rev++; broadcast(); log('reloaded design from disk'); }
  catch { /* half-written or deleted */ }
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
    case 'undo': return undo(by);
    case 'redo': return redo(by);
    default: throw new M.ModelError(`Unknown edit "${op.op}".`);
  }
}

// ---------- browser viewer ----------
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); };
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(200, view());
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
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { userOp(JSON.parse(body)); json(200, { ok: true }); }
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
  server.listen(port, HOST, () => { viewUrl = `http://${HOST === '0.0.0.0' ? os.hostname() : HOST}:${port}/`; log('viewer at', viewUrl); });
}
listen(PORT, 10);

// ---------- MCP tools ----------
const mcp = new McpServer({ name: 'breadboard', version: '0.2.0' });
const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const pendingEdits = () => userEdits.length - userEditsSeen;
const tool = (name, title, description, inputSchema, fn) =>
  mcp.registerTool(name, { title, description, inputSchema }, async (args) => {
    try {
      let out = await fn(args || {});
      if (name !== 'get_user_edits' && pendingEdits() > 0) {
        const note = `${pendingEdits()} edit(s) made by the user in the viewer since you last looked; call get_user_edits.`;
        out = typeof out === 'string' ? `${out}\n\n${note}` : { ...out, user_edits: note };
      }
      return text(out);
    } catch (e) { return { isError: true, ...text(e instanceof M.ModelError ? e.message : `Error: ${e.message}`) }; }
  });
const status = () => M.summarizeChecks(M.analyze(design));
const viewerLine = () => (viewUrl ? `Viewer: ${viewUrl}` : 'The viewer is not running.');
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
    return { placed: part.id, pins: L.pins.map((p) => `${p.key} ${p.name} @ ${p.hole}`), ...(L.covered.length ? { covers: `${L.covered.length} holes under the board` } : {}), status: status() };
  });
tool('move_part', 'Move a part', 'Move or rotate a placed part. Wires stay in their holes, so check connections afterwards.',
  { id: z.string(), at: z.string().optional(), rotation: rotation.optional(), to: z.string().optional() },
  (a) => { const p = mutate((d) => M.movePart(d, a), { label: `move ${a.id}` }); return `Moved ${p.id} to ${p.at}${p.rotation ? ' (rotated 180)' : ''}. ${status()}.`; });
tool('set_part_props', 'Change part settings', 'Change props such as the ESP32 power mode or the power module jumpers.',
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
tool('remove_wire', 'Remove a wire', 'Remove a wire by id (W3).',
  { id: z.string() }, (a) => { mutate((d) => M.removeWire(d, a), { label: `remove ${a.id}` }); return `Removed ${a.id}. ${status()}.`; });

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
tool('get_nets', 'List nets', 'Every net: which pins, strips and wires it joins, and its voltage if it is a supply.', {}, () => M.describeNets(design));
tool('check_design', 'Check the design',
  'Physical fit, shorts, supply voltages, common ground, I²C wiring and addresses, LED resistors, buttons and risky GPIOs. Fix every error before calling a layout done.',
  {}, () => { const a = M.analyze(design); return { summary: M.summarizeChecks(a), checks: a.checks.map((c) => `${c.level.toUpperCase()} [${c.code}] ${c.message}`), i2c: a.firmware.map(({ mcu, sda, scl, devices }) => ({ mcu, sda, scl, devices: devices.map(({ part, kind, address }) => ({ part, kind, address })) })) }; });
tool('get_viewer_url', 'Viewer link', 'The URL where the user can watch and edit the board.', {}, () => viewerLine());
tool('load_design', 'Load a design', 'Replace the design with a design object (the saved file format). Undo restores the previous one.',
  { design: z.record(z.string(), z.any()) },
  ({ design: d }) => { const next = M.normalizeDesign(d); mutate((draft) => { Object.keys(draft).forEach((k) => delete draft[k]); Object.assign(draft, next); }, { label: 'load design' }); return `Loaded "${design.name}". ${status()}.`; });

await mcp.connect(new StdioServerTransport());
log('MCP server ready; design file', DESIGN_PATH);
