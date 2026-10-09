# Auto-routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `route_nets` MCP tool that joins groups of endpoints with the fewest, neatest wires, and a power mode that wires all ground and supply pins.

**Architecture:** A pure `routeNets` function in `src/model.js` turns each net group into endpoints (each a set of candidate strips, or one exact hole), finds the components already joined in the current netlist, and repeatedly adds the cheapest wire between two components through the existing `addWire`. Cost is a pure `scoreWire`. Power mode builds the groups (ground, then one per voltage) and feeds the same engine. The server wraps it in `mutate()`.

**Tech Stack:** Node 18+, ES modules, `node:test`, `@modelcontextprotocol/sdk`, `zod`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-auto-routing-design.md` (read its "Clarifications" section; it settles points this plan relies on).

## Global Constraints

- Node >= 18, ES modules, no new dependencies.
- stdout belongs to MCP; log only to stderr.
- Every design change goes through `mutate()` in `server.js`.
- `ModelError` messages reach the user verbatim, in the "Net 2: ..." prefix style of `add_wires`.
- Cost weights live in one exported constant: `overPart: 6`, `crossing: 2`, `straight: -1`, `partMargin: 0.6`, `endMargin: 0.5`, `candidates: 12`. Units are pitch (0.1 in).
- Ties between equal costs are broken by the string `` `${fromHole}|${toHole}` `` in plain `<` order, so output is deterministic.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Commit only the files named in each task; leave the untracked `.claude/` folder alone.
- Tests never touch the user's design: use temp paths (`BREADBOARD_DESIGN`, `BREADBOARD_DESIGNS_DIR`) for any server run.

## Review Focus

Each line is pinned by a test in the task shown.

1. An explicit hole endpoint that is already taken: "Net 1: Hole a50 is taken ..." instead of silently using another hole (Task 1).
2. Neither nets nor power given: "Give at least one net, or set power to true." (Task 1).
3. A route that joins two supplies on purpose (`['U1.5V', 'U1.3V3']`): wires are added as asked and `check_design` reports `supply-clash` (Task 1).
4. Split rails: power wires must land on the powered half (Task 3).
5. Joined boards with a USB-powered ESP32: the rails live on different boards, and the result still has no errors (Task 3).

## File Structure

- `src/model.js`: new "routing" section after `removeWire`. Adds `ROUTE_WEIGHTS`, `scoreWire`, `routeNets` and internal helpers.
- `src/server.js`: the `route_nets` tool.
- `test/route.test.js`: all routing tests.
- `README.md`, `CLAUDE.md`: docs.

---

### Task 1: Net joining with distance-only cost

**Files:**
- Modify: `src/model.js` (new section between `removeWire` and `// ---------- analysis ----------`)
- Create: `test/route.test.js`

**Interfaces:**
- Produces:
  - `export const ROUTE_WEIGHTS = { overPart: 6, crossing: 2, straight: -1, partMargin: 0.6, endMargin: 0.5, candidates: 12 }`
  - `export function scoreWire(design, fromHole: string, toHole: string): number`. In this task it returns the straight-line distance between the two holes' centres, using `parseHole(...).col` and `.y`.
  - `export function routeNets(design, { nets = [], power = false } = {}): { wires: Wire[], satisfied: string[][], notes: string[] }`. `Wire` is what `addWire` returns (`id, from, to, color, via`). `satisfied` lists the groups, as given, that were already connected. Until Task 3, `power: true` throws `ModelError("Power mode isn't implemented yet.")`.
- Internal (not exported): `endpointOf(ref, design, layout)` returning `{ label, strips: string[], hole: string | null }`. A hole or `T+5` gives `hole` set and its strip; a pin (`U1.GPIO1`) gives the strips of every matching pin (reuse `findPins` and `footprint`); a bare rail (`T+`, `2:B-`) gives every strip of that rail on the named board, or on every board with no prefix.

- [ ] **Step 1: Write the failing tests** in `test/route.test.js`. Header helpers (copy exactly):

```js
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
```

Tests (name, then assertions):
  - `'two endpoints add one wire with the net colour'`: `routeNets(base(), { nets: [['U2.SDA', 'U1.GPIO8']] })` returns `wires.length === 1`, `wires[0].color === 'blue'`, and `joined(d, 'U2.SDA', 'U1.GPIO8')`.
  - `'three pins skip what is already connected'`: first `M.addWire(d, { from: 'U2.VCC', to: 'B+' })`, then `routeNets(d, { nets: [['U2.VCC', 'U2.CSB', 'B+']] })` adds exactly 1 wire and `joined(d, 'U2.VCC', 'U2.CSB')`.
  - `'running it twice adds nothing'`: route `[['U2.SDA', 'U1.GPIO8']]` twice; the second result has `wires.length === 0` and `satisfied` deep-equals `[['U2.SDA', 'U1.GPIO8']]`.
  - `'a bad group is found before any wire is added'`: `nets: [['U2.SDA', 'U1.GPIO8'], ['U2.SCL', 'U9.X']]` throws `/Net 2: .*No part called U9/` and `d.wires.length` is unchanged (same object, no clone). Also `[['U2.SDA']]` throws `/Net 1 needs at least two endpoints/`.
  - `'a taken explicit hole is refused'`: after `M.addWire(d, { from: 'a50', to: 'a52' })`, `nets: [['a50', 'U2.VCC']]` throws `/Net 1: Hole a50 is taken/`.
  - `'a full strip gives a clear error'`: wire `g40`, `h40`, `i40`, `j40` to `a55`, `a56`, `a57`, `a58` with `addWire`, then `nets: [['U2.VCC', 'U1.GPIO8']]` throws `/No free hole left for U2\.VCC/`.
  - `'no nets and no power is an error'`: `routeNets(base(), {})` throws `/Give at least one net, or set power to true/`.
  - `'joining two supplies is done and then flagged'`: on `M.newDesign()` with `esp32-s3-devkitc-1` at `b8` (USB default), `nets: [['U1.5V', 'U1.3V3']]` adds 1 wire and `M.analyze(d).checks.some((c) => c.code === 'supply-clash')`.

- [ ] **Step 2: Run `npm test`.** Expected: `test/route.test.js` fails with `routeNets is not a function` (the other suites still pass).

- [ ] **Step 3: Implement the signatures above in `src/model.js`.** Algorithm for `routeNets`:
  1. If no groups and `!power`, throw the "Give at least one net" error. Resolve every endpoint of every group first (`Net N: ` prefix on any error; a group with fewer than two endpoints throws `Net N needs at least two endpoints.`; an explicit hole already in `occupancy(design)` throws `Net N: Hole X is taken: ...`). Nothing is added before all groups pass.
  2. For each group, loop: call `analyze(design)`; a component key for a strip is `netByStrip.get(strip)?.root ?? strip`. Group the endpoints by component key (an endpoint's key comes from its first strip). One component: push the group to `satisfied` (only if no wire was added for it) and stop.
  3. Otherwise, candidate holes for a component are: each endpoint's exact `hole`, or its strips' free holes (`!occupancy.has(h)` and not in `overhangSet(...)`). A strip with more than `ROUTE_WEIGHTS.candidates` free holes keeps the nearest ones to the centroid of the other component's unpruned candidate holes. An endpoint with no free hole throws `Net N: No free hole left for <label>. Move a part, or use two joined boards.`
  4. Pick the pair of components and holes with the lowest `scoreWire`, ties broken per Global Constraints. Add it with `addWire(design, { from, to })`, push the result to `wires`, and repeat.

- [ ] **Step 4: Run `npm test`.** Expected: all pass.

- [ ] **Step 5: Commit** `src/model.js` and `test/route.test.js` with message `Add routeNets: join net groups with the fewest wires`.

---

### Task 2: Neatness cost

**Files:**
- Modify: `src/model.js` (`scoreWire`)
- Test: `test/route.test.js`

**Interfaces:**
- Consumes: `ROUTE_WEIGHTS`, `scoreWire`, `routeNets` from Task 1.
- Produces: `scoreWire` now returns `length + straight + overPart * count + crossing * count` as in the spec: `straight` applies when both holes share a column or a row (same `col` or same `y`); `overPart` counts holes from every part's `footprint(...).covered` and `.overhang` within `partMargin` of the segment, ignoring the first and last `endMargin` of its length; `crossing` counts `design.wires` whose straight segment properly crosses this one (interior of both segments; touching an endpoint is not a crossing).

- [ ] **Step 1: Write the failing tests** (empty design `M.newDesign()` unless stated):
  - `'a straight wire is cheaper than its length'`: `scoreWire(d, 'a10', 'a14')` equals `4 + M.ROUTE_WEIGHTS.straight`; `scoreWire(d, 'a10', 'b14')` is within `1e-9` of `Math.hypot(4, 1)`.
  - `'a wire over a dev board costs per hole'`: place `esp32-s3-devkitc-1` at `a8` (covers rows b to h of columns 8 to 29, 7 holes per column). Then `scoreWire(d, 'T+10', 'B+10') - scoreWire(d, 'T+6', 'B+6')` equals `7 * M.ROUTE_WEIGHTS.overPart`.
  - `'a crossing wire costs extra'`: add wire `T+15` to `c15`. Then `scoreWire(d, 'a10', 'a20') - scoreWire(d, 'c10', 'c20')` equals `M.ROUTE_WEIGHTS.crossing`. Row a crosses the wire; row c only touches its end.
  - `'the router picks the uncrossed hole'`: place resistors `R1` at `e10` to `e12` and `R2` at `e20` to `e22`, add wire `T+15` to `c15`, then `routeNets(d, { nets: [['R1.1', 'R2.1']] })` adds one wire whose sorted ends are `['c10', 'c20']`.
  - `'the same input gives the same wires'`: run that scenario on two `structuredClone` copies; `JSON.stringify` of the two `wires` arrays is equal.

- [ ] **Step 2: Run `npm test`.** Expected: the three `scoreWire` tests and the router test fail (length-only cost).

- [ ] **Step 3: Extend `scoreWire`.** Use `parseHole` for positions, `footprint` per part for covered and overhang holes (skip parts whose footprint throws), and point-to-segment distance for `overPart`. Wire segments for crossings use each wire's two holes.

- [ ] **Step 4: Run `npm test`.** Expected: all pass, including Task 1's tests.

- [ ] **Step 5: Commit** `src/model.js` and `test/route.test.js` with message `Score candidate wires for neatness`.

---

### Task 3: Power mode

**Files:**
- Modify: `src/model.js` (`routeNets`, new internal `powerGroups`)
- Test: `test/route.test.js`

**Interfaces:**
- Consumes: `routeNets` internals from Task 1 (endpoints, the join loop).
- Produces: `routeNets(design, { power: true })` builds extra groups (Clarifications in the spec) and runs them through the same join loop, before the user's nets. Internal `powerGroups(design, layout, analysis)` returns `{ groups: Endpoint[][], notes: string[] }`. Rail endpoints carry explicit strips (only powered or only grounded ones). Notes read `fed <rail> from <pin ref>`.
  - Ground group: one endpoint per part with `gnd` or `gnd-in` pins (all of that part's ground pins as alternatives; skip rail modules' own pins), plus one endpoint of every rail strip whose net is `ground`. If none, the `-` rail strip nearest the ESP32's GND pin.
  - Supply groups: consumers are `power-in` pins, an ESP32 `5v-pin` mode's 5V pin (5 V) and `3v3-pin` mode's 3V3 pin (3.3 V). Voltages come from powered rail strips and USB ESP32 pins. Each consumer takes 3.3 V if inside its `min`/`max`, else 5 V. Group by voltage. Use a powered rail strip of that voltage; if none, the unpowered `+` rail strip nearest the source pin, fed from that pin.
  - Power groups that are already connected appear in `satisfied` as arrays of endpoint labels (for example `['U2.VCC', 'B+']`).
  - Errors: `Nothing here supplies power. Place an MB102 or power the ESP32 over USB.` and `No supply fits U2.VCC (1.71-3.6 V). Available: 5 V. Use a source in that range or a different part.` (`Available:` lists the voltages as `3.3 V, 5 V`).

- [ ] **Step 1: Write the failing tests:**
  - `'power mode wires S3 + BME280 + MB102 cleanly'`: `d = base()`, `routeNets(d, { nets: [['U2.SDA', 'U1.GPIO8'], ['U2.SCL', 'U1.GPIO9']], power: true })`; `errors(d)` deep-equals `[]`, `netOf(M.analyze(d), 'U2.VCC').volts === 3.3`, `netOf(M.analyze(d), 'U1.5V').volts === 5`.
  - `'a USB ESP32 feeds a rail'`: `M.newDesign()` with `esp32-s3-devkitc-1` at `b8` and `bme280-3v3` at `f40`; route the same two I²C nets with `power: true`; `errors(d)` is `[]` and `notes.some((n) => /^fed .+ from U1\.3V3$/.test(n))`.
  - `'no fitting voltage is explained'`: MB102 at `1` with `{ top: '5V', bottom: 'off' }` and `bme280-3v3` at `f40`; `power: true` throws `/No supply fits U2\.VCC \(1\.71-3\.6 V\)\. Available: 5 V\./`. A design with only `bme280-3v3` throws `/Nothing here supplies power/`.
  - `'split rails: power lands on the powered half'`: `M.newDesign({ splitRails: true })`, MB102 at `1` with `{ top: '3V3', bottom: '3V3' }`, `bme280-3v3` at `f50`; after `power: true`, every wire end matching `/^[TB][+-]/` has column `<= 32` (`+h.slice(2) <= 32`) and there are at least 2 such ends.
  - `'joined boards with USB power have no errors'`: `M.newDesign({ boards: 2 })`, S3 at `d5`, `bme280-3v3` at `2:g40`; route the I²C nets with `power: true`; `errors(d)` is `[]`. If this fails for a reason unrelated to routing, adjust the BME280 placement, not the assertion.

- [ ] **Step 2: Run `npm test`.** Expected: the new tests fail with "Power mode isn't implemented yet."

- [ ] **Step 3: Implement `powerGroups`** and replace the Task 1 stub. User nets run after the power groups, so they can build on the rails.

- [ ] **Step 4: Run `npm test`.** Expected: all pass.

- [ ] **Step 5: Commit** `src/model.js` and `test/route.test.js` with message `Add power mode to routeNets`.

---

### Task 4: `route_nets` tool

**Files:**
- Modify: `src/server.js` (after `remove_wire`, using the existing `tool()` and `mutate()` helpers)

**Interfaces:**
- Consumes: `M.routeNets`.
- Produces: MCP tool `route_nets` with inputs `nets?: string[][]` and `power?: boolean`. It runs `mutate((d) => M.routeNets(d, { nets, power }), { label })` where `label` is `route N net(s)` plus ` + power` when set. It returns `{ added: string[], already_connected: string[][], notes: string[], status }`, with each `added` entry formatted like `add_wires` (`W3: a12 (U2.SDA) → b9 (U1.GPIO8), blue`).

- [ ] **Step 1: Implement the tool** with a description that tells Claude when to use it instead of `add_wires`: groups of endpoints that must be one net, or `power: true` to wire all ground and supply pins. State that explicit holes are used exactly and pins or bare rails let the tool choose.

- [ ] **Step 2: Smoke test over real MCP with temp paths.** Create a temp dir `T=$(mktemp -d)`; write `.smoke.mjs` in the repo root (it needs the repo's `node_modules`), using `Client` and `StdioClientTransport` from the SDK with `BREADBOARD_PORT=5290`, `BREADBOARD_DESIGN=$T/live.json`, `BREADBOARD_DESIGNS_DIR=$T/designs`. Calls, in order: `new_design`; `place_part` `esp32-s3-devkitc-1` at `b8`; `place_part` `bme280-3v3` at `f40`; `route_nets` with the I²C nets and `power: true`; `check_design`; `route_nets` with a bad net (`['U2.SCL', 'U9.X']`) then `get_design` (unchanged wire count); `undo` (wire count back to 0). Expected: `check_design` shows 0 errors, the bad net returns an error naming `Net 1`, and one `undo` removes the whole route. Delete `.smoke.mjs` and `$T` afterwards.

- [ ] **Step 3: Run `npm test`.** Expected: all pass.

- [ ] **Step 4: Commit** `src/server.js` with message `Add route_nets tool`.

---

### Task 5: Docs

**Files:**
- Modify: `README.md` (tools table), `CLAUDE.md` (Layout and Ideas)

- [ ] **Step 1: README.** Add a `route_nets` row to the Tools table: groups of pins, rails or holes to join with the fewest, neatest wires; `power: true` also wires all ground and supply pins; explicit holes are used exactly.
- [ ] **Step 2: CLAUDE.md.** Add a line under `src/model.js` for `routeNets`/`scoreWire` and the weights. In "Ideas not done yet", remove the "Auto-routing" line and add "A route button in the viewer, reusing `routeNets`."
- [ ] **Step 3: Run `npm test`.** Expected: all pass.
- [ ] **Step 4: Commit** `README.md` and `CLAUDE.md` with message `Document route_nets`.
