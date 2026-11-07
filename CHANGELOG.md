# Changelog

Notable changes to Breadboard Bench. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is 0.x, a minor bump (0.3.0) means new tools, parts or behaviour changes, and a patch bump (0.2.1) means fixes only.

Add a line under **Unreleased** in any pull request that changes what users see. See [Releasing](#releasing) at the end for how a version is cut.

## [Unreleased]

### Added
- `route_nets` tool: give groups of pins, rails or holes that must be one net, and the server adds the fewest wires, preferring short, straight ones that avoid parts and crossings. `power: true` also wires every ground and supply pin to a rail of a fitting voltage.
- Named designs: `save_design`, `list_designs` and `open_design`, stored in `~/.breadboard-bench/designs` (override with `BREADBOARD_DESIGNS_DIR`).
- Parts: the classic ESP32-DevKitC V4 and the NEO-6M GPS breakout.
- UART checks: the GPS module's TX and RX must be crossed to GPIOs, not shorted together or tied to a supply, with a `Serial1.begin(...)` hint once the wiring is right.
- Viewer: Net mode (click the pins to join, then Route net), a Route power button, a Tidy wires toggle for 90° wires, and a board colour picker.
- The viewer header and `get_viewer_url` show which design file the session uses.
- Tests run in CI on Node 18 and 22 for every pull request.

### Changed
- Renamed from breadboard-mcp to Breadboard Bench. Designs now live under `~/.breadboard-bench/`. A design at the old `~/.breadboard-mcp/design.json` is still loaded if there is no new one.
- Each Claude Code session keeps its own design file, `~/.breadboard-bench/sessions/<session id>.json`, and starts empty. Claude Desktop keeps using `~/.breadboard-bench/design.json`. `BREADBOARD_DESIGN` overrides both.
- If another process changes the design file, the next edit, undo or redo is refused and the design is reloaded, so nothing is overwritten. Changes are detected by a hash of the file's content, so a touch or a same-size write is handled correctly.

### Fixed
- An existing design file is loaded at startup. Before, the load failed silently and the server started empty.
- The viewer URL reports the port that was actually bound when the first choice was busy.
- `src/server.js` is executable, so the `breadboard-bench` command from `npm link` runs.

## [0.2.0] - 2026-10-02

First tagged version, released as breadboard-mcp.

### Added
- MCP server with tools to place, move and remove parts and wires, plus undo and redo, and design checks.
- Live viewer in the browser that you can edit, with the same validation as the tools.
- Joined and separate two-board layouts, half and full size boards, and split rails.
- Parts: ESP32-S3-DevKitC-1, ESP32-C5-DevKitC-1, BME280 (3.3 V and 5 V boards), SSD1306 OLED, MB102 power module, LED, resistor and push button.

[Unreleased]: https://github.com/stephenwil/breadboard-bench/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/stephenwil/breadboard-bench/tree/v0.2.0

## Releasing

1. Open a pull request named `Release x.y.z` that:
   - runs `npm version x.y.z --no-git-tag-version`, which updates `package.json` and `package-lock.json`;
   - renames `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, adds a fresh empty `## [Unreleased]` above it, and updates the compare links at the bottom of the version list.
2. Merge it once the tests pass.
3. Tag the merge commit and push the tag:
   ```sh
   git checkout main && git pull
   git tag vx.y.z && git push origin vx.y.z
   ```
4. `.github/workflows/release.yml` checks that the tag matches `package.json` and that this file has a section for the version. It then runs the tests, publishes to npm with provenance, and creates a GitHub release from that section.
