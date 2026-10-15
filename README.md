# Breadboard Bench

An MCP server that lets Claude lay out, wire and check breadboard circuits, with a live viewer you can also edit in.

Ask something like *"ESP32-S3 with a BME280, an OLED, a status LED and a button"*. Claude then:

1. Places the parts.
2. Runs the jumper wires.
3. Runs the design checks and fixes what they flag.

You watch it happen in your browser. If you move something by hand, Claude can see what you changed.

## Setup

Requires Node 18 or newer.

```sh
cd breadboard-bench
npm install
```

**Claude Code**

```sh
claude mcp add breadboard-bench -- node /absolute/path/to/breadboard-bench/src/server.js
```

**Claude Desktop**: add this to `claude_desktop_config.json` and restart Claude Desktop:

```json
{ "mcpServers": { "breadboard-bench": { "command": "node", "args": ["/absolute/path/to/breadboard-bench/src/server.js"] } } }
```

Then open the viewer at <http://127.0.0.1:5178/>. If you're not sure of the address, ask Claude for the viewer link.

| Variable | Default | What it does |
| --- | --- | --- |
| `BREADBOARD_PORT` | `5178` | Viewer port. If it's busy, the server tries the next 10 |
| `BREADBOARD_HOST` | `127.0.0.1` | Set to `0.0.0.0` to reach the viewer from your LAN. Anyone who can reach it can edit the board, so only do this on a trusted network |
| `BREADBOARD_DESIGN` | `~/.breadboard-bench/sessions/<session id>.json` in Claude Code, `~/.breadboard-bench/design.json` otherwise | Where the design is saved. Each Claude Code session gets its own file and starts with an empty design, so sessions don't overwrite each other; use `open_design` to bring in older work. Claude Desktop has no session id and keeps using `design.json` (a design at the old `~/.breadboard-mcp/design.json` is loaded if that file doesn't exist yet). Setting this variable overrides all of that, and two servers pointed at one file share it. If another process changes the file under a running server, the next edit is refused with "Another session changed this design" after the server reloads it, so nothing is overwritten. Check it with `get_design` and repeat the edit. If the file was unreadable, a copy is kept next to it as `<file>.bad-<time>` before the repeat overwrites it |
| `BREADBOARD_DESIGNS_DIR` | `~/.breadboard-bench/designs` | Folder for named designs saved with `save_design`. Point it at a folder in a repo to commit them |

## Boards

- **One board** (default): full size (63 columns) or half size (30).
- **Two joined boards** (`new_design` with `boards: 2`): two boards pushed together with the facing rail strips removed. This is the usual way to fit an ESP32 DevKitC with both headers reachable. Put J1 in row d or e of board 1, and J3 lands in row a or b of board 2. Holes on board 2 are written with a prefix, like `2:a12` or `2:B-5`.
- **Two separate boards** (`boards: 2, joined: false`): each keeps all four rails.

A power module needs both rail pairs on one board, so it doesn't fit a joined pair. Power that setup over USB instead. The checks explain this if you try.

## Viewer

- **Hover** a hole, pin or wire to see its net. Hover a check to see where it applies.
- **Select mode**
  - Drag a part to move it.
  - Click a wire, then drag either end.
  - Change props, rotate or delete from the Selection panel.
  - Shortcuts: `R` rotates, `Del` removes.
- **Wire mode** (`W` toggles it): click two holes to add a wire, after picking a colour.
- **Net mode** (`N` toggles it): click pins, rails or holes that belong on one net, then Route net (`Enter`). A pin or rail lets the server pick the hole; a free hole is used exactly. Click a pick again to drop it, `Esc` clears. One undo reverts the route.
- **Board colour**: pick cream, white, green, blue, red or black from the swatches after Tidy wires. Labels, holes and rail marks adjust so they stay readable, and black wires get a light edge on the black board. It is a viewer setting, saved in your browser, not part of the design.
- **Tidy wires** draws every wire with a 90° bend instead of a curve. Wires whose runs would overlap are moved a few pixels apart. It changes only how wires are drawn, not the design, and the viewer remembers your choice.
- **Route power** wires every ground and supply pin to a rail of a fitting voltage (the same as `route_nets` with `power: true`). One undo reverts it.
- **Undo and redo** cover both your edits and Claude's. Shortcuts: `Ctrl/Cmd+Z`, `Shift+Ctrl/Cmd+Z`.

Every edit goes through the same validation as Claude's tools. A move into a taken hole is refused, with the reason.

Your edits are logged. The next tool call Claude makes tells it there are edits to look at, and `get_user_edits` lists them.

## Tools

| Tool | Purpose |
| --- | --- |
| `board_info` | Hole naming, rails, how strips connect, layout tips for wide dev boards |
| `list_parts` | Part library, with pins, placement rules and props |
| `new_design` | Fresh board(s): size, 1 or 2 boards, joined or separate, split rails |
| `place_part`, `move_part`, `set_part_props`, `remove_part` | Parts |
| `add_wires`, `move_wire_end`, `remove_wire` | Wires. Each end can be a hole (`a12`, `2:b7`), a rail (`T+`, `2:B-`), or a part pin (`U1.GPIO8`, `U2.SDA`, `D1.A`), and the server picks a free hole for you |
| `route_nets` | Let the server choose the wires. Give groups of pins, rails or holes that must be one net; it adds the fewest wires, skips what is already connected, and prefers short, straight wires that avoid crossing parts and other wires. A hole is used exactly; a pin or bare rail lets it pick a free hole. `power: true` also wires every ground and supply pin to a rail of a fitting voltage, feeding a rail from a USB-powered ESP32 if none is powered. One undo reverts the whole route |
| `undo`, `redo` | Step through the shared history |
| `get_user_edits` | What you changed by hand in the viewer |
| `get_design`, `get_nets` | Read back pins, holes, nets and wires |
| `check_design` | All checks, plus a summary of the I²C buses |
| `save_design`, `list_designs`, `open_design` | Keep several designs. Each is saved as `<name>.json` in the designs folder; opening one replaces the current design (undo restores it), so save first if you want to keep it |
| `get_viewer_url`, `load_design` | Get the viewer link, or replace the design with a design object |

## Parts

| Type | Notes |
| --- | --- |
| `esp32-s3-devkitc-1` | Pin tables from Espressif's v1.1 guide. Props: power (usb, 5v-pin or 3v3-pin), module variant (octal variants reserve GPIO35–37), and revision (which GPIO drives the RGB LED) |
| `esp32-c5-devkitc-1` | v1.2 header table (boards from PW-2025-04-0446 on; v1.1 boards differ). Props: power, and psram (which takes GPIO15) |
| `bme280-3v3` | 6-pin breakout with no regulator, so 3.3 V only |
| `bme280-5v` | 4-pin breakout with a regulator, taking 3.3–5 V |
| `ssd1306-oled` | 0.96 in I²C OLED, address 0x3C. Pin order varies between sellers, so set `order` to match yours |
| `mb102-power` | Breadboard power module. Each side's rail can be 5V, 3V3 or off |
| `led` | `at` is the anode, `to` is the cathode |
| `resistor` | Two leads, `at` and `to` |
| `button` | 6 mm tactile switch straddling the centre gap. `at` is in row e |

## What the checks catch

- **Fit:** pins that land in taken holes, under a module, or under the power module's overhang.
- **Strip shorts:** two pins of one part in the same strip, for example a button wired so it's always closed.
- **Supply problems:**
  - Short circuits.
  - Two supply voltages tied together.
  - A supply back-feeding a USB-powered dev board.
  - Undervoltage, or overvoltage (such as a 3.3 V-only BME280 on 5 V).
- **Grounds:** grounds that aren't joined.
- **I²C:**
  - SDA or SCL not reaching a GPIO.
  - SDA and SCL shorted together.
  - The BME280's CSB pin tied low.
  - Two devices on one bus with the same address.
- **Risky GPIOs:** strapping pins, USB data pins, UART0, the RGB LED pin, and pins reserved by flash or PSRAM.
- **LEDs:** no series resistor, wired backwards, or shorted.
- **Buttons:** wiring hints, such as using `INPUT_PULLUP`.

## Assumptions to verify

- **Dev board header spacing:** modelled as 1.0 in. Change `rowSpacing` in `src/model.js` if yours differs.
- **Joined pair spacing:** board 2's row a is assumed to sit 1.3 in below board 1's row a. Set `offset` on board 2 in the design file if your pair measures differently.
- **Rails:** modelled with a hole in every column. Real rails skip one every five.
