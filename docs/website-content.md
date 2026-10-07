# Breadboard Bench: website content

Copy for a single-page site. Every claim is taken from the code and README as of version 0.2.0.

## SEO

**Title tag:** Breadboard Bench: an MCP server for realistic breadboard layouts

**Meta description:** Ask Claude for a breadboard layout and watch it appear in a live browser viewer. Breadboard Bench checks physical fit and wiring, and lets you edit by hand. Open source MCP server, Node 18+.

## Hero

**Headline:** Describe the circuit. Watch Claude build it on a breadboard.

**Subhead:** Breadboard Bench is an MCP server that lets Claude place parts, run jumper wires and check the result against how a real breadboard works. A live viewer shows the board, and you can edit it by hand.

**CTA (primary):** Get started (links to Quickstart)
**CTA (secondary):** View on GitHub

## How it works

1. **Ask Claude.** Describe what you want, for example "ESP32-S3 with a BME280 and a breadboard power supply".
2. **Claude uses the MCP tools.** It places parts, adds wires and runs the design checks, then fixes what they flag.
3. **Watch it live.** The viewer at http://127.0.0.1:5178 redraws as each change lands.
4. **Edit by hand.** Drag parts, move wire ends, or add wires in the viewer. Your edits go through the same validation as Claude's, so a move into a taken hole is refused with the reason.
5. **Both stay in sync.** Claude is told when you have made edits and can read exactly what changed, then carry on from your version of the board.

## Features

**Layouts that fit the real board.** Holes under a module are unusable. Each strip connects five holes. Rails can be split in the middle. Pins that land in a taken hole, under a module or under the power module's overhang are reported.

**Electrical checks, with the problem highlighted.** Short circuits, two supply voltages tied together, a supply back-feeding a USB-powered board, over- and undervoltage, unjoined grounds, I²C wiring and duplicate addresses, LEDs with no series resistor, and risky GPIOs (strapping, USB, UART0, flash/PSRAM pins). Hover a check in the viewer to see the holes it refers to.

**Undo and redo for both of you.** One shared history covers your edits and Claude's (the last 100 changes). Failed multi-step edits leave the design untouched.

**Named saved designs.** Save, list and reopen designs by name. Each is a plain `<name>.json` file in a folder you can point at a git repo.

**A part library with sourced pins.** Dev-board pin tables come from Espressif's user guides. Placement rules and props (power mode, module variant, pin order) are exposed to Claude through `list_parts`.

**Claude sees your edits.** Moves, deletions, new wires and prop changes made in the viewer are logged, and Claude's next tool call flags them so it can adapt instead of overwriting your work.

## Example conversation

> **You:** Lay out an ESP32-S3 DevKitC with a BME280 on I²C and a breadboard power supply. I'll power the ESP32 over USB.
>
> **Claude:** *(reads the board notes, starts a design with two joined boards, places the ESP32 so both headers are reachable, places the BME280, wires 3V3, GND, SDA and SCL, then runs `check_design`.)* The layout is in the viewer at http://127.0.0.1:5178/. One thing to know: the MB102 power module needs both rail pairs on one board, so it does not fit a joined pair. The checks flag it, so I would power the board over USB and use the 3.3 V pin for the sensor.
>
> **You:** *(drags the BME280 two columns right in the viewer)*
>
> **You:** I moved the sensor. Is everything still wired up?
>
> **Claude:** *(calls `get_user_edits`, then `check_design`)* You moved U2 to a new column, and its wires still point at the old holes. SDA and SCL no longer reach the sensor. I am moving the wire ends to match.

The exact wording will vary. The tools and checks it uses are the ones in the Tools list below.

## Supported parts

| Type | What it is |
| --- | --- |
| `esp32-s3-devkitc-1` | Espressif ESP32-S3-DevKitC-1, v1.1 pinout. Props: power source, module variant, board revision |
| `esp32-c5-devkitc-1` | Espressif ESP32-C5-DevKitC-1, v1.2 pinout (boards from PW-2025-04-0446 on). Props: power source, PSRAM |
| `bme280-3v3` | BME280 breakout, 6-pin, no regulator, 3.3 V only |
| `bme280-5v` | BME280 breakout, 4-pin, with regulator, 3.3 to 5 V |
| `ssd1306-oled` | 0.96 in I²C OLED, address 0x3C. Pin order is configurable because sellers differ |
| `mb102-power` | MB102-style breadboard power module. Each rail can be 5V, 3V3 or off |
| `led` | 3 mm or 5 mm LED |
| `resistor` | Two-lead resistor |
| `button` | 6 mm tactile switch straddling the centre gap |

## Quickstart

Requires Node 18 or newer.

```sh
git clone <repo-url> breadboard-bench   # replace with the repository address
cd breadboard-bench
npm install
```

**Claude Code**

```sh
claude mcp add breadboard-bench -- node /absolute/path/to/breadboard-bench/src/server.js
```

Inside the repo itself, a project-scoped `.mcp.json` is already included. Approve the server when Claude Code asks.

**Claude Desktop:** add this to `claude_desktop_config.json` and restart:

```json
{ "mcpServers": { "breadboard-bench": { "command": "node", "args": ["/absolute/path/to/breadboard-bench/src/server.js"] } } }
```

Open http://127.0.0.1:5178/ (or ask Claude for the viewer link), then ask for a layout. To run the tests: `npm test`.

Settings: `BREADBOARD_PORT` (default 5178; if busy, the next 10 ports are tried), `BREADBOARD_HOST`, `BREADBOARD_DESIGN`, `BREADBOARD_DESIGNS_DIR`.

## FAQ

**Is the viewer reachable from other machines?**
Not by default. It listens on 127.0.0.1 only. You can set `BREADBOARD_HOST=0.0.0.0` to reach it from your LAN, but anyone who can reach it can edit the board, so only do that on a network you trust.

**Where are my designs stored?**
The working copy is `~/.breadboard-bench/design.json`. Named designs go in `~/.breadboard-bench/designs/`. Both locations can be changed with environment variables. Undo history is kept in memory while the server runs, so save a named design before opening or starting another if you want to keep it.

**Can I trust the physical dimensions?**
Mostly, with three exceptions that are assumed rather than measured: dev-board header spacing is modelled as 1.0 in, the second board of a joined pair sits 1.3 in below the first, and the MB102 is modelled as overhanging about four columns of the main area. Check against your own hardware.

**Do the rails match my breadboard?**
Not exactly. Rails are modelled with a hole in every column, while many real rails skip one hole every five. Rails can be split in the middle if yours are.

**Can it handle parts that are not in the library?**
Not yet. The library has the nine types above. New parts are added in code, and pin data is meant to come from manufacturer documentation.

**Does it simulate the circuit?**
No. It checks wiring, fit, supply voltages and common mistakes. It does not simulate current, LED brightness or firmware behaviour.

## Roadmap

These are ideas, not commitments, and none of them exist yet.

- Rails that skip a hole every five, to match real boards
- More parts: classic ESP32-DevKitC, Pico, DHT22, relay, potentiometer
- An auto-layout helper that suggests where to place parts
- Auto-routing from a list of nets, instead of placing each wire
- Export of a wiring list or schematic
- An ammeter or LED simulation in the viewer

## Footer

Breadboard Bench is an open source MCP server (ISC licence per package.json) that runs on your machine. Nothing leaves it unless you expose the viewer yourself. Pin data comes from Espressif's user guides; check any layout against your own parts before powering it. Not affiliated with Espressif or Anthropic.
