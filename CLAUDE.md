# Breadboard Bench: context for Claude

## What this is
An MCP server that lets Claude design breadboard layouts and wiring. The user asks for something like "ESP32-S3 with a BME280 and a breadboard power supply", and Claude does the rest through the MCP tools. A live browser viewer at http://127.0.0.1:5178 shows the board and lets the user edit it by hand.

The goal is realistic layouts. Physical fit matters as much as electrical correctness: holes under modules are unusable, strips connect five holes, and rails can be split.

This repo is set up as an MCP server for this project in `.mcp.json`, so the `breadboard-bench` tools are available while you work here. Approve the server when Claude Code asks.

## Layout
- `src/model.js`: all domain logic, written as pure functions over a plain design object.
  - Board geometry and hole parsing (`a12`, `T+5`, `2:b7` for board 2).
  - The part library (`LIBRARY`) and footprints.
  - Edit operations, which throw `ModelError` with messages written for the user.
  - `analyze()`: builds the netlist and runs every check.
  - `buildView()`: the JSON the browser renders.
- `src/server.js`: the MCP server (stdio) plus an HTTP server for the viewer.
  - The HTTP side serves `/`, `/api/state`, SSE on `/api/events`, and `POST /api/op` for browser edits. That endpoint requires the `x-breadboard: 1` header.
  - Holds the undo and redo history and the log of user edits.
  - Saves to `~/.breadboard-bench/design.json`, which can be overridden with `BREADBOARD_DESIGN`. If that file is missing and the pre-rename `~/.breadboard-mcp/design.json` exists, the old one is loaded (and saved to the new path on the next change).
- `public/index.html`: the viewer, in a single file with no build step. It draws the board from `buildView()` output and sends edits to `/api/op`.
- `test/model.test.js`: model tests, run with `npm test`.

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
- ESP32-C5-DevKitC-1 pins: Espressif's user guide, v1.2 header tables. Boards from PW-2025-04-0446 on use these; v1.1 differs.
- Assumed, not verified:
  - DevKitC header spacing of 1.0 in (`rowSpacing: 10`).
  - Joined boards: board 2's row a sits 1.3 in below board 1's.
  - The MB102 overhangs about four columns of the main area.
  - Rails have a hole in every column. Real rails skip one every five.

## Ideas not done yet
- Rails that skip a hole every five, to match real boards.
- More parts: classic ESP32-DevKitC, Pico, DHT22, relay, potentiometer.
- An auto-layout helper that suggests where to place parts.
- Exporting a wiring list or schematic.
- An ammeter or LED simulation in the viewer. The earlier claude.ai prototype had these.
