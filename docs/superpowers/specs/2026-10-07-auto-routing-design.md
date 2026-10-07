# Auto-routing: design

Date: 2026-10-07. Status: draft, awaiting review.

## Goal

Let Claude say which pins must be connected, and have the tool choose the wires, instead of placing each one with `add_wires`. The wires it picks should look neat, and a power mode should wire all ground and supply pins on its own.

Success looks like:
- A list of nets produces the fewest wires that join each net, and nothing for pins that are already connected.
- Running it on S3 + BME280 + MB102 with `power: true` gives a design with 0 errors.
- Layouts look tidy: short wires, few crossings, and few wires passing over parts.
- One undo reverts a whole route, and a failed route changes nothing.

## Scope

In:
- `routeNets(design, { nets, power })` in `src/model.js`.
- An MCP tool `route_nets` in `src/server.js`.
- Tests in `test/route.test.js`, and updates to `README.md` and `CLAUDE.md`.

Out (for now):
- A route button in the viewer. The convention says browser edits and MCP tools share validation, so this is a follow-up that reuses `routeNets` unchanged. It goes in the `CLAUDE.md` ideas list.
- A dry-run preview. Undo covers it.
- Changing or removing wires that already exist.
- Config tie-offs such as BME280 CSB and SDO, and the ESP32 `power` prop. The user lists tie-offs as nets.
- A path-searching router. Jumper wires arc over the board, so only hole choice matters.

## Interface

`route_nets` arguments:
- `nets`: array of groups. Each group is an array of endpoints in the forms `add_wires` accepts (hole such as `a12` or `2:b7`, rail such as `T+` or `2:B-`, or part pin such as `U1.GPIO1`). Each group ends up as one net.
- `power`: boolean, default false. When true, it also wires every ground and supply pin.

`routeNets` mutates the draft design like the other edit functions and returns:
- `wires`: the wires added (id, from, to, colour, via).
- `satisfied`: groups that were already connected.
- `notes`: lines such as "fed rail T+ from U1.3V3".

The server runs it inside `mutate()` with the label "route N nets", so it is all-or-nothing and one undo reverts it. Running it twice adds nothing the second time.

## Algorithm

For each net group:
1. **Strips.** Each endpoint becomes a strip: a pin gives the strip of its hole, a rail gives the rail strip, a hole gives its own strip. An endpoint that matches several pins (for example `U1.GND`) stays as alternatives, and the cost picks among them.
2. **Components.** Using the current netlist, strips that are already connected form one component. If all the group's endpoints are in one component, report it in `satisfied` and move on.
3. **Join greedily.** Among all pairs of separate components, find the cheapest wire. A wire may use any free hole in the strips of the group's own endpoints. For a long strip such as a rail, only the 12 free holes nearest the other side are considered. Commit that wire, merge the two components, mark both holes as used, and repeat until one component is left.
4. **Reuse validation.** Each wire is added through the same code as `addWire`, with explicit holes, so hole checks, same-strip checks and colour logic are shared.

### Cost of a candidate wire

In pitch units (0.1 in):
- Length: the straight-line distance between the holes.
- Over a part: +6 for each hole under a part body or overhang that lies within 0.6 pitch of the wire, ignoring the first and last 0.5 pitch of the wire so it can leave its own pin.
- Crossing: +2 for each existing or newly added wire it crosses, treating wires as straight lines.
- Straight: -1 if both ends share a row or a column.
- Tie-break: lowest cost, then lowest hole name, so the same input always gives the same wires.

The weights are starting values in one named constant, to be tuned on real layouts.

## Power mode

Power mode builds groups and passes them to the same engine.

- **Ground group:** every `gnd` and `gnd-in` pin, plus a ground rail. That is the rail an MB102 already grounds, or the rail nearest the ESP32's GND pin if none is grounded.
- **Supply groups:** one per voltage. Each `power-in` pin takes the lowest available source voltage inside its `min`/`max`, preferring 3.3 V. Sources are powered rails and, when the ESP32 is USB-powered, its 3V3 and 5V pins. Pins are grouped by chosen voltage, and each group is wired to a powered rail of that voltage. If no rail is powered, an unpowered rail near the source pin is fed from the ESP32's 3V3 or 5V pin. Two voltages never share a rail.

## Errors

All are `ModelError`, using the "Net 2: ..." prefix style of `add_wires`, and leave the design untouched.
- A group with fewer than two endpoints: "Net 2 needs at least two endpoints."
- An unknown pin, hole or rail: the existing messages, with the net named.
- No supply anywhere in the design: "Nothing here supplies power. Place an MB102 or power the ESP32 over USB."
- A pin no available voltage fits: "No supply fits U2.VCC (3.0-3.6 V). Available: 5 V. Use a 3.3 V source or a different part."
- No free holes: the existing "No free hole left for ..." message.

## Testing

`test/route.test.js`:
1. A two-endpoint net adds exactly one wire, with the right colour.
2. A three-pin net adds two wires and skips pins that are already connected.
3. Running it twice adds nothing the second time, and the groups are reported as satisfied.
4. Power mode on S3 + BME280 + MB102 gives 0 errors, with BME280 VCC on 3.3 V.
5. Power mode on a USB-powered ESP32 feeds a rail from the 3V3 pin.
6. A part with no fitting voltage gives the clear error.
7. With two equally long options, it picks the one that doesn't cross a part or another wire.
8. The same design and nets give identical wires.
9. A failed route leaves the design unchanged.

Also run `npm test` and one end-to-end MCP smoke run on temp paths (`BREADBOARD_DESIGN`, `BREADBOARD_DESIGNS_DIR`) so the live design is not touched.

## Open points to confirm while building

- How `analyze()` exposes pin strips and part-covered holes for the cost function. If it needs a small helper in `model.js`, add one rather than duplicating logic.
- The straight-line crossing test treats curved wires as straight. If that looks wrong in the viewer, revisit it after the first version.
