# Breadboard Bench: context for Claude

## What this is
An MCP server that lets Claude design breadboard layouts and wiring. The user asks for something like "ESP32-S3 with a BME280 and a breadboard power supply", and Claude does the rest through the MCP tools. A live browser viewer at http://127.0.0.1:5178 shows the board and lets the user edit it by hand.

The goal is realistic layouts. Physical fit matters as much as electrical correctness: holes under modules are unusable, strips connect five holes, and rails can be split.

This repo is set up as an MCP server for this project in `.mcp.json`, so the `breadboard-bench` tools are available while you work here. Approve the server when Claude Code asks.

## Scope of sessions in this repo
Sessions here are for developing the server, model and viewer. Circuit design requests (laying out a board, placing parts, wiring) belong in a separate design session. If one turns up here, say so instead of editing the live design. Use test designs or temp files (`BREADBOARD_DESIGN`, `BREADBOARD_DESIGNS_DIR`) when trying the tools, so the user's designs under `~/.breadboard-bench/` stay untouched.

## Layout
- `src/model.js`: all domain logic, written as pure functions over a plain design object.
  - Board geometry and hole parsing (`a12`, `T+5`, `2:b7` for board 2).
  - The part library (`LIBRARY`) and footprints.
  - Edit operations, which throw `ModelError` with messages written for the user.
  - `routeNets()` and `scoreWire()`: auto-routing behind the `route_nets` tool. It joins groups of endpoints with the fewest wires, adding each through `addWire`. `scoreWire` is the neatness cost (length, straight bonus, penalty per hole under a part, penalty per crossing), with the weights in `ROUTE_WEIGHTS`. `power: true` builds ground and supply groups from the parts' pin roles. Spec and plan: `docs/superpowers/`.
  - `analyze()`: builds the netlist and runs every check.
  - `buildView()`: the JSON the browser renders.
- `src/server.js`: the MCP server (stdio) plus an HTTP server for the viewer.
  - The HTTP side serves `/`, `/api/state`, SSE on `/api/events`, and `POST /api/op` for browser edits. That endpoint requires the `x-breadboard: 1` header.
  - Holds the undo and redo history and the log of user edits.
  - Saves each Claude Code session's design to `~/.breadboard-bench/sessions/<CLAUDE_CODE_SESSION_ID>.json`, created on the first edit. With no session id (Claude Desktop) it uses `~/.breadboard-bench/design.json`. `BREADBOARD_DESIGN` overrides both. The choice is `designPathFor()` in `designs.js`. For the shared file only: if it is missing and the pre-rename `~/.breadboard-mcp/design.json` exists, the old one is loaded (and saved to the new path on the next change).
  - `guardExternal()` runs before every edit, undo and redo. If another process changed the file since this server last read or wrote it (`seen`, a time-and-size stamp), the server reloads it, clears the history and refuses the edit with a `ModelError`; nothing is overwritten.
- `src/designs.js`: named designs, one `<name>.json` per design in `~/.breadboard-bench/designs` (override with `BREADBOARD_DESIGNS_DIR`). Backs the `save_design`, `list_designs` and `open_design` tools. It also holds `designPathFor()` and `designLabel()`, which choose the live design file and its short name (shown in the viewer header and by `get_viewer_url`). File names go through `designFileName()` in `model.js` so a name can't escape the folder. The live working copy is a separate file per session, as above.
- `public/index.html`: the viewer, in a single file with no build step. It draws the board from `buildView()` output and sends edits to `/api/op`.
- `site/index.html`: the marketing page, a single static file deployed to GitHub Pages by `.github/workflows/pages.yml`. It is separate from `public/`, which the server serves. Keep its part list, checks, install commands and limitations in step with the model and README, and update it when a feature ships or a roadmap item lands. It is excluded from the npm package via `files` in `package.json`.
- `test/model.test.js`, `test/designs.test.js`, `test/route.test.js`: model, saved-design and routing tests, run with `npm test`.
- `test/session.test.js`, `test/helpers/mcp.js`: start the real server over MCP against a temp `HOME` to test the file choice and the conflict guard. `npm test` runs them with the rest, about half a minute in all.

## Conventions
- stdout belongs to the MCP protocol. Log only to stderr (`console.error`).
- Every design change goes through `mutate()` in `server.js`. It works on a copy and commits only on success, so a failed multi-step edit leaves the design untouched. It also records undo history and logs user edits.
- Browser edits and MCP tools must apply the same validation. Add new edits to `model.js` first, then expose them in both places.
- `ModelError` messages reach the user verbatim. They should say what went wrong and how to fix it.
- Checks return `{ level: 'error' | 'warning' | 'info', code, message, holes }`. `holes` drives the highlight in the viewer.
- Pin data must come from a primary source (manufacturer docs). Cite the source in the part's description, and flag anything assumed.
- After changing the model, run `npm test`. After changing the viewer, open it and check it by eye.

## Sources and assumptions
- ESP32-S3-DevKitC-1 pins: Espressif's user guide, v1.1 header tables.
- Classic ESP32-DevKitC V4 pins: Espressif ESP32-DevKitC V4 user guide (esp-dev-kits), J2 and J3 header tables. Strapping pins (0, 2, 5, 12, 15) and input-only pins (34–39) are from the ESP32 datasheet, not the guide.
- ESP32-C5-DevKitC-1 pins: Espressif's user guide, v1.2 header tables. Boards from PW-2025-04-0446 on use these; v1.1 differs.
- Assumed, not verified:
  - DevKitC header spacing of 1.0 in (`rowSpacing: 10`).
  - Joined boards: board 2's row a sits 1.3 in below board 1's.
  - The MB102 overhangs about four columns of the main area.
  - Rails have a hole in every column. Real rails skip one every five.

## Known gaps
Deferred from reviews; none loses data today. Fix when touching the area.
- Design file guard (`server.js`):
  - The stamp is taken after the file is read, so a write in that microsecond gap is missed.
  - The stamp is only modification time and size. A same-size write within the timestamp granularity is missed, and a touch-only change (a sync or backup tool) gives a false refusal and clears undo. Compare content, or add inode and ctime.
  - The temp file `<file>.tmp` has the same name in every process, so two processes writing at once can interleave. Use a pid-suffixed name.
- Tests: temp `HOME` folders and design dirs made by `test/helpers/mcp.js` and `test/session.test.js` are never removed. The viewer's toast for a refused browser edit was not checked by eye.
- Routing (`model.js`):
  - `power: true` with nothing to power returns an empty success with no hint.
  - `best` in the join loop is used without a null guard (it can't be null today).
  - `scoreWire` recomputes footprints for every candidate pair, and `analyze()` runs once per added wire. Fine at current sizes.
  - The split-rails and joined-boards routing tests only check column <= 32 and "no errors", not which rail is fed.
- `CLAUDE_CODE_SESSION_ID` is assumed to stay the same when a session is resumed. It did across a restart; not seen on `--resume`.

## Ideas not done yet
- Rails that skip a hole every five, to match real boards.
- More parts: Pico, DHT22, relay, potentiometer.
- An auto-layout helper that suggests where to place parts.
- Cleaning up old session design files.
- A design switcher in the viewer.
- Exporting a wiring list or schematic.
- An ammeter or LED simulation in the viewer. The earlier claude.ai prototype had these.
