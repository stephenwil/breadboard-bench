// Breadboard model: geometry, part library, design operations, netlist and design checks.
// Units are hole pitches (0.1 in / 2.54 mm). Columns are 1-based like the numbers printed on a board.
// A design can hold several breadboards stacked top to bottom. Holes on board 1 are written a12 / T+5;
// holes on later boards carry a prefix: 2:a12, 2:B-7.

export const ROW_Y = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 7, g: 8, h: 9, i: 10, j: 11 };
export const RAIL_Y = { 'T-': -3.5, 'T+': -2.5, 'B+': 13.5, 'B-': 14.5 };
export const RAILS = Object.keys(RAIL_Y);
export const SIZES = {
  half: { cols: 30, label: 'half-size breadboard (30 columns)' },
  full: { cols: 63, label: 'full-size breadboard (63 columns)' },
};
export const RAIL_SETS = { both: ['T-', 'T+', 'B+', 'B-'], top: ['T-', 'T+'], bottom: ['B+', 'B-'], none: [] };
export const WIRE_COLORS = ['red', 'black', 'orange', 'yellow', 'green', 'blue', 'purple', 'white', 'grey'];
const Y_ROW = Object.fromEntries(Object.entries(ROW_Y).map(([r, y]) => [y, r]));
// Board outline relative to its row a, with and without a rail pair on that side.
const EDGE = { top: { rails: -4.8, none: -0.9 }, bottom: { rails: 15.8, none: 11.9 } };

export class ModelError extends Error {}
const fail = (m) => { throw new ModelError(m); };

// ---------- boards ----------
export function boardLayout(design) {
  const out = [];
  design.boards.forEach((b, i) => {
    const rails = RAIL_SETS[b.rails] || RAIL_SETS.both;
    const hasTop = rails.includes('T+'), hasBot = rails.includes('B+');
    const top = hasTop ? EDGE.top.rails : EDGE.top.none, bottom = hasBot ? EDGE.bottom.rails : EDGE.bottom.none;
    let oy = 0;
    if (i > 0) {
      const p = out[i - 1];
      const seam = !p.hasBot && !hasTop ? 0.2 : 0.6;
      oy = typeof b.offset === 'number' ? p.oy + b.offset : p.oy + p.bottom + seam - top;
    }
    out.push({ index: i + 1, size: b.size, cols: SIZES[b.size].cols, rails, railsMode: b.rails, splitRails: !!b.splitRails, oy, top, bottom, hasTop, hasBot });
  });
  return out;
}
const prefix = (k) => (k > 1 ? `${k}:` : '');

export function parseHole(s, design, layout = boardLayout(design)) {
  const m = /^\s*(?:(\d)\s*:\s*)?(T\+|T-|B\+|B-|[a-jA-J])\s*(\d{1,2})\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const k = m[1] ? +m[1] : 1, B = layout[k - 1];
  if (!B) return null;
  const row = m[2].length === 1 ? m[2].toLowerCase() : m[2].toUpperCase();
  const col = +m[3];
  if (col < 1 || col > B.cols) return null;
  const rail = row.length === 2;
  if (rail && !B.rails.includes(row)) return null;
  const ly = rail ? RAIL_Y[row] : ROW_Y[row];
  return { id: prefix(k) + row + col, board: k, row, col, rail, ly, y: B.oy + ly };
}
function hole(board, row, col, design, layout) { return parseHole(prefix(board) + row + col, design, layout); }
function holeAtY(col, y, design, layout) {
  for (const B of layout) {
    const ly = y - B.oy, r = Math.round(ly);
    if (Math.abs(ly - r) < 0.25 && Y_ROW[r] !== undefined && col <= B.cols) return hole(B.index, Y_ROW[r], col, design, layout);
  }
  return null;
}
function holesInColumn(col, design, layout) {
  const out = [];
  for (const B of layout) {
    if (col > B.cols) continue;
    for (const r of [...B.rails, ...Object.keys(ROW_Y)]) out.push(hole(B.index, r, col, design, layout));
  }
  return out;
}
export function allHoles(design, layout = boardLayout(design)) {
  const out = [];
  for (const B of layout) for (let c = 1; c <= B.cols; c++) for (const r of [...B.rails, ...Object.keys(ROW_Y)]) out.push(hole(B.index, r, c, design, layout));
  return out;
}
export function stripOf(h, design, layout = boardLayout(design)) {
  const p = `${h.board}:`;
  if (h.rail) {
    const B = layout[h.board - 1];
    return p + h.row + (B.splitRails ? (h.col <= Math.ceil(B.cols / 2) ? 'L' : 'R') : '');
  }
  return p + (h.ly <= 4 ? 'U' : 'L') + h.col;
}
export function stripHoles(strip, design, layout = boardLayout(design)) {
  const [k, s] = strip.split(':'), B = layout[+k - 1], out = [];
  if (/^[TB][+-]/.test(s)) {
    const rail = s.slice(0, 2), side = s[2], half = Math.ceil(B.cols / 2);
    for (let c = 1; c <= B.cols; c++) {
      if ((side === 'L' && c > half) || (side === 'R' && c <= half)) continue;
      out.push(prefix(+k) + rail + c);
    }
    return out;
  }
  const c = +s.slice(1);
  for (const r of s[0] === 'U' ? 'abcde' : 'fghij') out.push(prefix(+k) + r + c);
  return out;
}
export function describeStrip(strip, design) {
  const [k, s] = strip.split(':');
  const where = design.boards.length > 1 ? ` on board ${k}` : '';
  if (/^[TB][+-]/.test(s)) {
    const name = { 'T+': 'top + rail', 'T-': 'top − rail', 'B+': 'bottom + rail', 'B-': 'bottom − rail' }[s.slice(0, 2)];
    return `${name}${s[2] ? ` (${s[2] === 'L' ? 'left' : 'right'} half)` : ''}${where}`;
  }
  return `column ${s.slice(1)} rows ${s[0] === 'U' ? 'a–e' : 'f–j'}${where}`;
}

// ---------- part library ----------
const devkitPin = (uart) => (label) => {
  if (label === '3V3') return { role: 'power', volts: 3.3, name: '3V3' };
  if (label === '5V') return { role: 'power', volts: 5, name: '5V' };
  if (label === 'G') return { role: 'gnd', name: 'GND' };
  if (label === 'RST') return { role: 'en', name: 'RST' };
  if (label === 'EN') return { role: 'en', name: 'EN' };
  if (label === 'NC') return { role: 'nc', name: 'NC' };
  if (label === 'TX') return { role: 'gpio', gpio: uart.TX, name: `TX (GPIO${uart.TX})` };
  if (label === 'RX') return { role: 'gpio', gpio: uart.RX, name: `RX (GPIO${uart.RX})` };
  return { role: 'gpio', gpio: +label, name: 'GPIO' + label };
};
const POWER_PROP = { default: 'usb', options: ['usb', '5v-pin', '3v3-pin'], help: 'usb: powered from its USB port, so the 3V3 and 5V pins are outputs. 5v-pin or 3v3-pin: fed from the breadboard through that pin. Espressif lists these as mutually exclusive.' };
const SPACING_NOTE = 'Header spacing is assumed to be 1.0 in. Check it against the dimension drawing for your board.';
const headerNames = (lib) => lib.headerNames || ['J1', 'J3'];
const OCTAL = ['N8R8', 'N16R8V', 'N32R8V', 'N32R16V'];

export const LIBRARY = {
  'esp32-s3-devkitc-1': {
    name: 'Espressif ESP32-S3-DevKitC-1 (v1.1 pinout)',
    kind: 'dual-header', mcu: true, prefix: 'U', short: 'ESP32-S3',
    description:
      'ESP32-S3 dev board with two 22-pin headers, J1 and J3. `at` is the hole for J1 pin 1 (3V3). Rotation 0: J1 runs towards higher columns and J3 sits 10 pitches below; rotation 180: towards lower columns with J3 10 pitches above. ' +
      'On a single breadboard it covers every row between its headers, so only one header keeps a free hole per pin. To reach both headers use two joined boards (new_design with boards: 2) and put J1 in row d or e of board 1.',
    rowSpacing: 10, spacingNote: SPACING_NOTE,
    headers: {
      J1: ['3V3', '3V3', 'RST', '4', '5', '6', '7', '15', '16', '17', '18', '8', '3', '46', '9', '10', '11', '12', '13', '14', '5V', 'G'],
      J3: ['G', 'TX', 'RX', '1', '2', '42', '41', '40', '39', '38', '37', '36', '35', '0', '45', '48', '47', '21', '20', '19', 'G', 'G'],
    },
    pinInfo: devkitPin({ TX: 43, RX: 44 }),
    ties: ['3V3', 'G'],
    props: {
      power: POWER_PROP,
      module: { default: 'N8R8', options: ['N8', 'N8R2', 'N8R8', 'N16R8V', 'N32R8V', 'N32R16V'], help: 'Module variant. Octal flash/PSRAM variants (N8R8, N16R8V, N32R8V, N32R16V) reserve GPIO35–37.' },
      revision: { default: 'v1.1', options: ['v1.0', 'v1.1'], help: 'The onboard RGB LED is on GPIO38 (v1.1) or GPIO48 (v1.0).' },
    },
    gpioNotes: (props) => [
      ...(OCTAL.includes(props.module) ? [{ gpios: [35, 36, 37], level: 'error', text: `is used internally by octal flash/PSRAM on the ${props.module}, so it isn't available` }] : []),
      { gpios: [0, 3, 45, 46], level: 'warning', text: 'is a strapping pin, sampled at boot; driving it can stop the board booting or change its mode' },
      { gpios: [19, 20], level: 'warning', text: 'is a native USB data line; using it disables native USB' },
      { gpios: [43, 44], level: 'warning', text: 'is UART0, used for the serial console and flashing' },
      { gpios: [props.revision === 'v1.0' ? 48 : 38], level: 'warning', text: `also drives the onboard RGB LED on ${props.revision} boards` },
    ],
  },
  'esp32-c5-devkitc-1': {
    name: 'Espressif ESP32-C5-DevKitC-1 (v1.2 pinout)',
    kind: 'dual-header', mcu: true, prefix: 'U', short: 'ESP32-C5',
    description:
      'ESP32-C5 dev board with two 16-pin headers, J1 and J3, using the v1.2 header table (boards from PW-2025-04-0446 on; v1.1 boards differ). `at` is the hole for J1 pin 1 (3V3). Placement works like the S3 board: one header per board on a single breadboard, both headers on two joined boards.',
    rowSpacing: 10, spacingNote: SPACING_NOTE,
    headers: {
      J1: ['3V3', 'RST', '2', '3', '0', '1', '6', '7', '8', '9', '10', '26', '25', '5V', 'G', 'NC'],
      J3: ['G', 'TX', 'RX', '24', '23', '15', '27', '4', '5', 'NC', '28', 'G', '14', '13', 'G', 'NC'],
    },
    pinInfo: devkitPin({ TX: 11, RX: 12 }),
    ties: ['3V3', 'G'],
    props: {
      power: POWER_PROP,
      psram: { default: 'no', options: ['no', 'yes'], help: 'Set to yes if your module has SPI PSRAM, which takes GPIO15.' },
    },
    gpioNotes: (props) => [
      ...(props.psram === 'yes' ? [{ gpios: [15], level: 'error', text: 'is used for SPI PSRAM on this module, so it isn\'t available' }] : []),
      { gpios: [2, 3, 7, 25, 26, 27, 28], level: 'warning', text: 'is a strapping pin, sampled at boot; driving it can stop the board booting or change its mode' },
      { gpios: [13, 14], level: 'warning', text: 'is a native USB data line; using it disables native USB' },
      { gpios: [11, 12], level: 'warning', text: 'is UART0, used for the serial console and flashing' },
      { gpios: [27], level: 'warning', text: 'also drives the onboard RGB LED' },
    ],
  },
  'esp32-devkitc-v4': {
    name: 'Espressif ESP32-DevKitC V4 (classic ESP32, WROOM/WROVER)',
    kind: 'dual-header', mcu: true, prefix: 'U', short: 'ESP32',
    description:
      'Classic ESP32 dev board with two 19-pin headers, J2 and J3 (Espressif ESP32-DevKitC V4 user guide, header block tables). `at` is the hole for J2 pin 1 (3V3). Placement works like the S3 board: one header per board on a single breadboard, both headers on two joined boards with J2 in row d or e of board 1. ' +
      'GPIO6–11 are the internal flash and are not usable. Strapping pins and input-only pins come from the ESP32 datasheet, not the DevKitC guide. VP and VN are shown as GPIO36 and GPIO39.',
    headerNames: ['J2', 'J3'],
    rowSpacing: 10, spacingNote: SPACING_NOTE,
    headers: {
      J2: ['3V3', 'EN', '36', '39', '34', '35', '32', '33', '25', '26', '27', '14', '12', 'G', '13', '9', '10', '11', '5V'],
      J3: ['G', '23', '22', 'TX', 'RX', '21', 'G', '19', '18', '5', '17', '16', '4', '0', '2', '15', '8', '7', '6'],
    },
    pinInfo: devkitPin({ TX: 1, RX: 3 }),
    ties: ['3V3', 'G'],
    props: {
      power: POWER_PROP,
      module: { default: 'wroom', options: ['wroom', 'wrover'], help: 'Boards with an ESP32-WROVER module use GPIO16 and GPIO17 for PSRAM; only WROOM and SOLO-1 boards have them free.' },
    },
    gpioNotes: (props) => [
      { gpios: [6, 7, 8, 9, 10, 11], level: 'error', text: 'is wired to the internal SPI flash, so it isn\'t available' },
      ...(props.module === 'wrover' ? [{ gpios: [16, 17], level: 'error', text: 'is reserved for PSRAM on WROVER modules, so it isn\'t available' }] : []),
      { gpios: [34, 35, 36, 39], level: 'warning', text: 'is input only, with no output driver or internal pull-up' },
      { gpios: [0, 2, 5, 12, 15], level: 'warning', text: 'is a strapping pin, sampled at boot; driving it can stop the board booting or change its mode' },
      { gpios: [1, 3], level: 'warning', text: 'is UART0, used for the serial console and flashing' },
    ],
  },
  'bme280-3v3': {
    name: 'BME280 breakout, 3.3 V only (6-pin, e.g. GY-BME280)',
    kind: 'single-header', prefix: 'U', short: 'BME280',
    description: 'Bare BME280 board with no regulator: VCC must be 3.3 V. Pins in one row: VCC, GND, SCL, SDA, CSB, SDO. `at` is the first pin\'s hole; pins run towards higher columns (rotation 0) or lower (180). Set props.order if your board differs. If unsure which BME280 board you have, assume this one.',
    pins: [
      { key: 'VCC', role: 'power-in', min: 1.71, max: 3.6 }, { key: 'GND', role: 'gnd-in' },
      { key: 'SCL', role: 'scl' }, { key: 'SDA', role: 'sda' }, { key: 'CSB', role: 'csb' }, { key: 'SDO', role: 'addr' },
    ],
    props: { order: { default: '', help: 'Comma-separated pin order if your board differs.' } },
    address: (L) => {
      const sdo = L.pins.find((p) => p.role === 'addr');
      if (sdo && sdo.net.ground) return { value: '0x76', note: 'SDO tied to ground' };
      if (sdo && sdo.net.sources.length) return { value: '0x77', note: 'SDO tied high' };
      return { value: '0x76 or 0x77', note: 'depends on the board; run an I²C scan' };
    },
  },
  'bme280-5v': {
    name: 'BME280 breakout with 3.3 V regulator (4-pin)',
    kind: 'single-header', prefix: 'U', short: 'BME280',
    description: 'BME280 board with an onboard regulator and I²C pull-ups; VIN accepts 3.3–5 V. Pins: VIN, GND, SCL, SDA. Only choose this if the seller confirms a regulator. Set props.order if your pin order differs.',
    pins: [{ key: 'VIN', role: 'power-in', min: 3.0, max: 5.5 }, { key: 'GND', role: 'gnd-in' }, { key: 'SCL', role: 'scl' }, { key: 'SDA', role: 'sda' }],
    props: { order: { default: '', help: 'Comma-separated pin order if your board differs.' } },
    address: () => ({ value: '0x76 or 0x77', note: 'depends on the board; run an I²C scan' }),
  },
  'ssd1306-oled': {
    name: 'SSD1306 0.96 in OLED, I²C (4-pin)',
    kind: 'single-header', prefix: 'U', short: 'OLED',
    description: '128×64 I²C OLED. Default pin order GND, VCC, SCL, SDA; many sellers swap GND and VCC, so check yours and set props.order. Most modules have a regulator and accept 3.3–5 V.',
    pins: [{ key: 'GND', role: 'gnd-in' }, { key: 'VCC', role: 'power-in', min: 3.0, max: 5.5 }, { key: 'SCL', role: 'scl' }, { key: 'SDA', role: 'sda' }],
    props: { order: { default: '', help: 'Comma-separated pin order, e.g. "VCC,GND,SCL,SDA".' } },
    address: () => ({ value: '0x3C', note: 'some modules use 0x3D' }),
  },
  'mb102-power': {
    name: 'Breadboard power supply module (MB102 style)',
    kind: 'rail-module', prefix: 'PS', short: 'PSU',
    description: 'Plugs into both rail pairs at one end of a board that has them. Each side has a jumper for 5V, 3V3 or off. `at` is a column at one end (1 or the last), with a board prefix for later boards (2:1). Its body overhangs about four columns of the main area at that end.',
    props: {
      top: { default: '5V', options: ['5V', '3V3', 'off'], help: 'Voltage on the top + rail.' },
      bottom: { default: '3V3', options: ['5V', '3V3', 'off'], help: 'Voltage on the bottom + rail.' },
    },
  },
  led: {
    name: 'LED (5 mm or 3 mm)',
    kind: 'two-lead', prefix: 'D', short: 'LED',
    description: '`at` is the anode (long leg, +) and `to` is the cathode (short leg, −). Needs a series resistor.',
    leads: [{ key: 'A', name: 'anode', role: 'led-a' }, { key: 'K', name: 'cathode', role: 'led-k' }],
    props: { color: { default: 'red', options: ['red', 'green', 'yellow', 'blue', 'white'], help: 'LED colour.' } },
  },
  resistor: {
    name: 'Resistor',
    kind: 'two-lead', prefix: 'R', short: 'R',
    description: 'Two leads: `at` and `to`. Use for pull-ups, pull-downs or LED current limiting.',
    leads: [{ key: '1', name: 'lead 1', role: 'passive' }, { key: '2', name: 'lead 2', role: 'passive' }],
    props: { ohms: { default: 10000, help: 'Resistance in ohms.' } },
  },
  button: {
    name: '6 mm tactile push button (4-pin)',
    kind: 'tactile', prefix: 'SW', short: 'Button',
    description: 'Straddles the centre gap. `at` is its top-left leg, which must be in row e; the legs land at e and f of that column and of the column two to the right. The two legs in one column are always connected; pressing joins the left column to the right one.',
    ties: ['1', '2'],
    props: {},
  },
};

// ---------- footprints ----------
export function footprint(part, design, layout = boardLayout(design)) {
  const lib = LIBRARY[part.type];
  if (!lib) fail(`Unknown part type "${part.type}". Call list_parts for the library.`);
  const dir = part.rotation === 180 ? -1 : 1;
  const pins = [], covered = [], overhang = [];
  let body = null;
  const mainAt = (what = 'at') => {
    const h = parseHole(part.at, design, layout);
    if (!h || h.rail) fail(`${part.id}: "${what}" must be a main-area hole like b5${design.boards.length > 1 ? ' or 2:b5' : ''} (got "${part.at}").`);
    return h;
  };
  const sameRow = (at, col, what) => {
    const h = hole(at.board, at.row, col, design, layout);
    if (!h) fail(`${part.id} doesn't fit: ${what} would land at column ${col}, off the board.`);
    return h;
  };

  if (lib.kind === 'dual-header') {
    const at = mainAt();
    const yB = at.y + dir * lib.rowSpacing;
    const [nameA, nameB] = headerNames(lib), count = lib.headers[nameA].length;
    for (let i = 0; i < count; i++) {
      const c = at.col + dir * i;
      const h1 = sameRow(at, c, `${nameA} pin ${i + 1}`);
      const h3 = holeAtY(c, yB, design, layout);
      if (!h3) {
        fail(`${part.id}: with ${nameA} in ${at.id} the ${nameB} header would land ${lib.rowSpacing} pitches ${dir > 0 ? 'below' : 'above'}, where there are no holes. ` +
          (design.boards.length > 1 ? `On two joined boards, put ${nameA} in row d or e of board 1 with rotation 0.` : `With rotation ${dir > 0 ? 0 : 180} on one board, put ${nameA} in row ${dir > 0 ? 'a or b' : 'i or j'}.`));
      }
      for (const [hdr, h] of [[nameA, h1], [nameB, h3]]) {
        const label = lib.headers[hdr][i];
        pins.push({ key: `${hdr}.${i + 1}`, label, hole: h.id, ...lib.pinInfo(label) });
      }
      const y0 = Math.min(at.y, yB), y1 = Math.max(at.y, yB);
      for (const h of holesInColumn(c, design, layout)) if (h.y > y0 + 0.01 && h.y < y1 - 0.01) covered.push(h.id);
    }
    const cA = at.col, cB = at.col + dir * (count - 1);
    body = { c0: Math.min(cA, cB) - 0.45, c1: Math.max(cA, cB) + 0.45, y0: Math.min(at.y, yB) - 0.6, y1: Math.max(at.y, yB) + 0.6, pin1End: dir > 0 ? 'left' : 'right' };
  } else if (lib.kind === 'single-header') {
    const at = mainAt();
    const keys = lib.pins.map((p) => p.key);
    let order = keys;
    if (part.props?.order) {
      order = String(part.props.order).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (!(order.length === keys.length && keys.every((k) => order.includes(k)))) fail(`${part.id}: props.order must list each of ${keys.join(', ')} exactly once.`);
    }
    order.forEach((k, i) => {
      const def = lib.pins.find((p) => p.key === k);
      pins.push({ ...def, key: k, label: k, name: k, hole: sameRow(at, at.col + dir * i, `pin ${k}`).id });
    });
    const cA = at.col, cB = at.col + dir * (order.length - 1), up = at.ly <= 4;
    body = { c0: Math.min(cA, cB) - 0.5, c1: Math.max(cA, cB) + 0.5, y0: up ? at.y - 2.5 : at.y + 0.45, y1: up ? at.y - 0.45 : at.y + 2.5, upright: true };
  } else if (lib.kind === 'rail-module') {
    const m = /^\s*(?:(\d)\s*:\s*)?(\d{1,2})\s*$/.exec(String(part.at));
    const k = m && m[1] ? +m[1] : 1, B = layout[k - 1], c = m ? +m[2] : NaN;
    if (!B || !(c >= 1 && c <= B.cols)) fail(`${part.id}: "at" must be a column number${design.boards.length > 1 ? ', optionally with a board prefix like 2:1' : ''} (got "${part.at}").`);
    if (B.rails.length < 4) fail(`${part.id}: a power module needs both rail pairs on one board, and board ${k} has ${B.rails.length ? 'only one pair' : 'none'}. Power the circuit another way (for example the dev board's USB), or add a separate board for the module.`);
    for (const rail of RAILS) pins.push({ key: rail, label: rail, name: rail.replace('-', '−'), hole: hole(k, rail, c, design, layout).id, role: rail.endsWith('+') ? 'supply' : 'gnd', side: rail[0] });
    const toward = c <= B.cols / 2 ? 1 : -1;
    for (let s = 0; s < 4; s++) {
      const cc = c + toward * s;
      if (cc < 1 || cc > B.cols) continue;
      for (const r of [...Object.keys(ROW_Y), ...(cc !== c ? RAILS : [])]) overhang.push(hole(k, r, cc, design, layout).id);
    }
    body = { c0: Math.min(c, c + toward * 3) - 0.5, c1: Math.max(c, c + toward * 3) + 0.5, y0: B.oy - 4.6, y1: B.oy + 15.6 };
  } else if (lib.kind === 'two-lead') {
    const a = parseHole(part.at, design, layout), b = parseHole(part.to, design, layout);
    if (!a || !b) fail(`${part.id}: set "at" and "to" to holes (got "${part.at}" and "${part.to}").`);
    if (a.id === b.id) fail(`${part.id}: both leads can't go in the same hole.`);
    pins.push({ ...lib.leads[0], label: lib.leads[0].key, hole: a.id });
    pins.push({ ...lib.leads[1], label: lib.leads[1].key, hole: b.id });
  } else if (lib.kind === 'tactile') {
    const at = mainAt();
    if (at.row !== 'e') fail(`${part.id}: a push button straddles the centre gap, so "at" must be in row e (got ${at.id}).`);
    for (const [c, side] of [[at.col, '1'], [at.col + 2, '2']]) {
      for (const row of ['e', 'f']) {
        const h = hole(at.board, row, c, design, layout);
        if (!h) fail(`${part.id} doesn't fit: it needs columns ${at.col} and ${at.col + 2}.`);
        pins.push({ key: `${side}${row === 'e' ? 'a' : 'b'}`, label: side, name: `side ${side}`, role: 'switch', hole: h.id });
      }
    }
    body = { c0: at.col - 0.5, c1: at.col + 2.5, y0: at.y - 0.6, y1: at.y + 3.6 };
  }
  return { pins, covered, overhang, body };
}

// ---------- design ----------
export function newDesign({ name = 'Untitled', size = 'full', boards = 1, joined = true, splitRails = false } = {}) {
  if (!SIZES[size]) fail(`Board size must be one of: ${Object.keys(SIZES).join(', ')}.`);
  if (![1, 2].includes(boards)) fail('boards must be 1 or 2.');
  const list = boards === 1
    ? [{ size, rails: 'both', splitRails }]
    : joined
      ? [{ size, rails: 'top', splitRails }, { size, rails: 'bottom', splitRails }]
      : [{ size, rails: 'both', splitRails }, { size, rails: 'both', splitRails }];
  return { version: 2, name, boards: list, parts: [], wires: [], nextWire: 1 };
}
export function normalizeDesign(d) {
  if (!d || typeof d !== 'object') fail('Design must be an object.');
  let boards;
  if (Array.isArray(d.boards) && d.boards.length) boards = d.boards.slice(0, 4).map((b) => ({ size: SIZES[b.size] ? b.size : 'full', rails: RAIL_SETS[b.rails] ? b.rails : 'both', splitRails: !!b.splitRails, ...(typeof b.offset === 'number' ? { offset: b.offset } : {}) }));
  else boards = [{ size: SIZES[d.board] ? d.board : 'full', rails: 'both', splitRails: !!d.splitRails }]; // v1 files
  const out = { version: 2, name: String(d.name || 'Untitled'), boards, parts: [], wires: [], nextWire: 1 };
  out.parts = Array.isArray(d.parts) ? d.parts.filter((p) => p && LIBRARY[p.type] && p.id).map((p) => ({ ...p, props: normalizeProps(LIBRARY[p.type], p.props || {}, true) })) : [];
  out.wires = Array.isArray(d.wires) ? d.wires.filter((w) => w && w.id && w.from && w.to).map((w) => ({ id: w.id, from: w.from, to: w.to, color: WIRE_COLORS.includes(w.color) ? w.color : 'green' })) : [];
  out.nextWire = Math.max(d.nextWire || 1, ...out.wires.map((w) => (+String(w.id).replace(/\D/g, '') || 0) + 1));
  return out;
}
// A saved design's file name (without .json): lowercase letters, digits, - and _ only, so a name can't point outside the folder.
export function designFileName(name) {
  const safe = String(name ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (!safe) fail('Give the design a name with at least one letter or digit.');
  return safe;
}
function normalizeProps(lib, props, lenient = false) {
  const out = {};
  for (const [k, spec] of Object.entries(lib.props || {})) {
    let v = props[k] ?? spec.default;
    if (spec.options && !spec.options.includes(v)) {
      if (lenient) v = spec.default;
      else fail(`Prop "${k}" must be one of: ${spec.options.join(', ')} (got "${v}").`);
    }
    if (k === 'ohms') { v = Number(v); if (!(v > 0)) fail('ohms must be a positive number.'); }
    out[k] = v;
  }
  if (!lenient) {
    const unknown = Object.keys(props).filter((k) => !(k in (lib.props || {})));
    if (unknown.length) fail(`Unknown prop(s) ${unknown.join(', ')}. Valid: ${Object.keys(lib.props || {}).join(', ') || 'none'}.`);
  }
  return out;
}

function describeOcc(o) {
  if (o.kind === 'pin') return `${o.by} pin ${o.pin} is there`;
  if (o.kind === 'wire') return `wire ${o.by} ends there`;
  if (o.kind === 'covered') return `it's under ${o.by}'s board`;
  return o.by;
}
export function occupancy(design, { exceptPart, exceptWire } = {}) {
  const layout = boardLayout(design), occ = new Map();
  for (const p of design.parts) {
    if (p.id === exceptPart) continue;
    let fp; try { fp = footprint(p, design, layout); } catch { continue; }
    for (const x of fp.pins) occ.set(x.hole, { by: p.id, kind: 'pin', pin: x.key });
    for (const h of fp.covered) if (!occ.has(h)) occ.set(h, { by: p.id, kind: 'covered' });
  }
  for (const w of design.wires) {
    if (w.id === exceptWire) continue;
    for (const h of [w.from, w.to]) if (!occ.has(h) || occ.get(h).kind === 'covered') occ.set(h, { by: w.id, kind: 'wire' });
  }
  return occ;
}
function validatePlacement(part, design) {
  const fp = footprint(part, design);
  const occ = occupancy(design, { exceptPart: part.id });
  const clash = fp.pins.filter((p) => occ.has(p.hole)).map((p) => `${p.key} → ${p.hole} (${describeOcc(occ.get(p.hole))})`);
  for (const h of fp.covered) { const o = occ.get(h); if (o && o.kind === 'pin') clash.push(`the board would sit on ${o.by}'s pin at ${h}`); }
  if (clash.length) fail(`${part.id} can't go there: ${clash.slice(0, 6).join('; ')}${clash.length > 6 ? `; and ${clash.length - 6} more` : ''}.`);
  return fp;
}
export function placePart(design, { type, id, at, rotation = 0, props = {}, to }) {
  const lib = LIBRARY[type];
  if (!lib) fail(`Unknown part type "${type}". Available: ${Object.keys(LIBRARY).join(', ')}.`);
  if (id && design.parts.some((p) => p.id === id)) fail(`There's already a part called ${id}.`);
  if (!id) { let k = 1; while (design.parts.some((p) => p.id === lib.prefix + k)) k++; id = lib.prefix + k; }
  if (!/^[A-Za-z][\w-]{0,15}$/.test(id)) fail('Part ids must start with a letter and use letters, digits, _ or - (max 16 chars).');
  const part = { id, type, at: String(at), rotation: rotation === 180 ? 180 : 0, props: normalizeProps(lib, props) };
  if (lib.kind === 'two-lead') part.to = String(to ?? '');
  validatePlacement(part, design);
  design.parts.push(part);
  return part;
}
export function movePart(design, { id, at, rotation, to }) {
  const i = design.parts.findIndex((p) => p.id === id);
  if (i < 0) fail(`No part called ${id}.`);
  const part = { ...design.parts[i] };
  if (at !== undefined) part.at = String(at);
  if (rotation !== undefined) part.rotation = rotation === 180 ? 180 : 0;
  if (to !== undefined) part.to = String(to);
  validatePlacement(part, design);
  design.parts[i] = part;
  return part;
}
export function setPartProps(design, { id, props }) {
  const part = design.parts.find((p) => p.id === id);
  if (!part) fail(`No part called ${id}.`);
  const next = { ...part, props: normalizeProps(LIBRARY[part.type], { ...part.props, ...props }) };
  validatePlacement(next, design);
  Object.assign(part, next);
  return part;
}
export function removePart(design, { id }) {
  const i = design.parts.findIndex((p) => p.id === id);
  if (i < 0) fail(`No part called ${id}.`);
  design.parts.splice(i, 1);
}

// ---------- wires ----------
function findPins(fp, partId, name) {
  const q = String(name).trim().toUpperCase().replace(/\s+/g, '');
  const num = q.replace(/^(GPIO|IO)(\d+)$/, '$2');
  const aliases = { GND: 'G', '3.3V': '3V3', '3V': '3V3', VBUS: '5V', EN: 'RST', ANODE: 'A', CATHODE: 'K', '+': 'A', '-': 'K' };
  for (const c of [q, num, aliases[q]].filter(Boolean)) {
    const byKey = fp.pins.filter((p) => p.key.toUpperCase() === c);
    if (byKey.length) return byKey;
    const byLabel = fp.pins.filter((p) => String(p.label).toUpperCase() === c);
    if (byLabel.length) return byLabel;
    const byGpio = fp.pins.filter((p) => p.role === 'gpio' && String(p.gpio) === c);
    if (byGpio.length) return byGpio;
  }
  if (q === 'GND') { const g = fp.pins.filter((p) => /gnd/.test(p.role)); if (g.length) return g; }
  fail(`${partId} has no pin "${name}". Its pins: ${[...new Set(fp.pins.map((p) => p.name))].join(', ')}.`);
}
function overhangSet(design, layout) {
  const s = new Set();
  for (const p of design.parts) { try { footprint(p, design, layout).overhang.forEach((h) => s.add(h)); } catch { /* skip */ } }
  return s;
}
function resolveEnd(ref, design, occ, near, towardRail) {
  const layout = boardLayout(design), avoid = overhangSet(design, layout);
  const s = String(ref ?? '').trim();
  const h = parseHole(s, design, layout);
  if (h) {
    if (occ.has(h.id)) fail(`Hole ${h.id} is taken: ${describeOcc(occ.get(h.id))}.`);
    return { hole: h.id, via: h.id };
  }
  const rail = /^(?:(\d)\s*:\s*)?(T\+|T-|B\+|B-)$/i.exec(s);
  if (rail) {
    const r = rail[2].toUpperCase();
    const n = near ? parseHole(near, design, layout) : null;
    const boards = rail[1] ? [layout[+rail[1] - 1]].filter(Boolean) : layout;
    const cands = [];
    for (const B of boards) {
      if (!B.rails.includes(r)) continue;
      for (let c = 1; c <= B.cols; c++) {
        const id = prefix(B.index) + r + c;
        if (occ.has(id) || avoid.has(id)) continue;
        const y = B.oy + RAIL_Y[r];
        cands.push({ id, d: n ? Math.abs(c - n.col) + Math.abs(y - n.y) * 0.5 : c });
      }
    }
    if (!cands.length) fail(`No free hole on a ${r} rail${rail[1] ? ` of board ${rail[1]}` : ''}. ${boards.some((B) => B.rails.includes(r)) ? '' : 'That board has no such rail.'}`.trim());
    cands.sort((x, y) => x.d - y.d);
    return { hole: cands[0].id, via: r };
  }
  const pm = /^([A-Za-z][\w-]*)\.(.+)$/.exec(s);
  if (pm) {
    const part = design.parts.find((p) => p.id.toUpperCase() === pm[1].toUpperCase());
    if (!part) fail(`No part called ${pm[1]}.`);
    const fp = footprint(part, design, layout);
    const matches = findPins(fp, part.id, pm[2]);
    if (towardRail && matches.length > 1) {
      // Prefer the pin nearest the rail the wire is heading for.
      const ys = layout.filter((B) => B.rails.includes(towardRail)).map((B) => B.oy + RAIL_Y[towardRail]);
      const dist = (pin) => Math.min(...ys.map((y) => Math.abs(parseHole(pin.hole, design, layout).y - y)));
      if (ys.length) matches.sort((a, b) => dist(a) - dist(b));
    }
    const tried = [];
    for (const pin of matches) {
      const ph = parseHole(pin.hole, design, layout), strip = stripOf(ph, design, layout);
      const free = stripHoles(strip, design, layout).filter((x) => !occ.has(x) && !avoid.has(x)).map((x) => parseHole(x, design, layout));
      if (!free.length) { tried.push(`${pin.key} (${describeStrip(strip, design)})`); continue; }
      free.sort((x, y) => (Math.abs(x.y - ph.y) + Math.abs(x.col - ph.col)) - (Math.abs(y.y - ph.y) + Math.abs(y.col - ph.col)));
      return { hole: free[0].id, via: `${part.id}.${pin.name}` };
    }
    fail(`No free hole left for ${part.id}.${matches[0].name}: every hole in the strip of ${tried.join(', ')} is taken or under a board. Move a part, or use two joined boards.`);
  }
  fail(`Couldn't read "${s}". Use a hole (a12, T+5, 2:b7), a rail (T+, B-, 2:B+) or a part pin (U1.GPIO8, U2.SDA).`);
}
function autoColor(design, holes) {
  const a = analyze(design), layout = boardLayout(design);
  const nets = holes.map((h) => a.netByStrip.get(stripOf(parseHole(h, design, layout), design, layout))).filter(Boolean);
  const pins = nets.flatMap((n) => n.pins);
  if (nets.some((n) => n.ground) || pins.some((p) => /gnd/.test(p.role))) return 'black';
  const v = nets.flatMap((n) => n.sources.map((s) => s.volts)).concat(pins.filter((p) => p.role === 'power' || p.role === 'power-in').map((p) => p.volts ?? (p.max > 4 ? 5 : 3.3)));
  if (v.length) return Math.max(...v) >= 5 ? 'red' : 'orange';
  if (pins.some((p) => p.role === 'sda')) return 'blue';
  if (pins.some((p) => p.role === 'scl')) return 'yellow';
  return 'green';
}
export function addWire(design, { from, to, color }) {
  if (color && !WIRE_COLORS.includes(color)) fail(`Colour must be one of: ${WIRE_COLORS.join(', ')}.`);
  const occ = occupancy(design);
  const isRail = (r) => /^(?:\d\s*:\s*)?(T\+|T-|B\+|B-)$/i.test(String(r).trim());
  let A, B;
  const railName = (r) => String(r).trim().toUpperCase().replace(/^\d\s*:\s*/, '');
  if (isRail(from) && !isRail(to)) { B = resolveEnd(to, design, occ, null, railName(from)); occ.set(B.hole, { by: 'new', kind: 'wire' }); A = resolveEnd(from, design, occ, B.hole); }
  else { A = resolveEnd(from, design, occ, null, isRail(to) ? railName(to) : null); occ.set(A.hole, { by: 'new', kind: 'wire' }); B = resolveEnd(to, design, occ, A.hole); }
  const layout = boardLayout(design);
  const sa = stripOf(parseHole(A.hole, design, layout), design, layout), sb = stripOf(parseHole(B.hole, design, layout), design, layout);
  if (sa === sb) fail(`Both ends would be in the same strip (${describeStrip(sa, design)}), which is already connected. The wire isn't needed.`);
  const wire = { id: 'W' + design.nextWire++, from: A.hole, to: B.hole, color: color || autoColor(design, [A.hole, B.hole]) };
  design.wires.push(wire);
  return { ...wire, via: [A.via, B.via] };
}
export function moveWireEnd(design, { id, end, to }) {
  const w = design.wires.find((x) => x.id === id);
  if (!w) fail(`No wire called ${id}.`);
  if (!['from', 'to'].includes(end)) fail('end must be "from" or "to".');
  const h = parseHole(to, design);
  if (!h) fail(`"${to}" isn't a hole on this design.`);
  const occ = occupancy(design, { exceptWire: id });
  if (occ.has(h.id)) fail(`Hole ${h.id} is taken: ${describeOcc(occ.get(h.id))}.`);
  const other = end === 'from' ? w.to : w.from;
  if (h.id === other) fail('Both ends of a wire can\'t share a hole.');
  w[end] = h.id;
  return w;
}
export function setWireColor(design, { id, color }) {
  const w = design.wires.find((x) => x.id === id);
  if (!w) fail(`No wire called ${id}.`);
  if (!WIRE_COLORS.includes(color)) fail(`Colour must be one of: ${WIRE_COLORS.join(', ')}.`);
  w.color = color;
  return w;
}
export function removeWire(design, { id }) {
  const i = design.wires.findIndex((w) => w.id === id);
  if (i < 0) fail(`No wire called ${id}.`);
  design.wires.splice(i, 1);
}

// ---------- routing ----------
// Weights are in pitch units (0.1 in).
export const ROUTE_WEIGHTS = { overPart: 6, crossing: 2, straight: -1, partMargin: 0.6, endMargin: 0.5, candidates: 12 };

// Neatness cost of a wire between two holes: lower is tidier. Length, a bonus for running straight along a
// row or column, a penalty per hole under a part that the wire passes over, and one per wire it crosses.
export function scoreWire(design, fromHole, toHole) {
  const W = ROUTE_WEIGHTS, layout = boardLayout(design);
  const pt = (id) => { const h = parseHole(id, design, layout); return { x: h.col, y: h.y }; };
  const A = pt(fromHole), B = pt(toHole), dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
  let cost = len;
  if (A.x === B.x || A.y === B.y) cost += W.straight;

  const under = new Set();
  for (const part of design.parts) {
    try { const fp = footprint(part, design, layout); for (const h of [...fp.covered, ...fp.overhang]) under.add(h); } catch { /* bad placement is reported by analyze */ }
  }
  if (len > 2 * W.endMargin) {
    for (const id of under) {
      const p = pt(id), t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / len; // distance along the wire
      if (t >= W.endMargin && t <= len - W.endMargin && Math.abs((p.x - A.x) * dy - (p.y - A.y) * dx) / len <= W.partMargin) cost += W.overPart;
    }
  }

  const side = (P, Q, R) => { const c = (Q.x - P.x) * (R.y - P.y) - (Q.y - P.y) * (R.x - P.x); return Math.abs(c) < 1e-9 ? 0 : Math.sign(c); };
  for (const w of design.wires) {
    if (!parseHole(w.from, design, layout) || !parseHole(w.to, design, layout)) continue;
    const C = pt(w.from), D = pt(w.to);
    if (side(A, B, C) * side(A, B, D) < 0 && side(C, D, A) * side(C, D, B) < 0) cost += W.crossing; // proper crossing only
  }
  return cost;
}

// An endpoint is one exact hole, or a set of strips the router may pick a free hole from.
function endpointOf(ref, design, layout) {
  const s = String(ref ?? '').trim();
  const h = parseHole(s, design, layout);
  if (h) return { label: s, strips: [stripOf(h, design, layout)], hole: h.id };
  const rail = /^(?:(\d)\s*:\s*)?(T\+|T-|B\+|B-)$/i.exec(s);
  if (rail) {
    const name = rail[2].toUpperCase(), strips = new Set();
    for (const B of rail[1] ? layout.filter((x) => x.index === +rail[1]) : layout) {
      if (!B.rails.includes(name)) continue;
      for (let c = 1; c <= B.cols; c++) strips.add(stripOf(parseHole(prefix(B.index) + name + c, design, layout), design, layout));
    }
    if (!strips.size) fail(`There is no ${name} rail${rail[1] ? ` on board ${rail[1]}` : ''} in this design.`);
    return { label: s, strips: [...strips], hole: null };
  }
  const pm = /^([A-Za-z][\w-]*)\.(.+)$/.exec(s);
  if (pm) {
    const part = design.parts.find((p) => p.id.toUpperCase() === pm[1].toUpperCase());
    if (!part) fail(`No part called ${pm[1]}.`);
    const pins = findPins(footprint(part, design, layout), part.id, pm[2]);
    return { label: s, strips: [...new Set(pins.map((p) => stripOf(parseHole(p.hole, design, layout), design, layout)))], hole: null };
  }
  fail(`Couldn't read "${s}". Use a hole (a12, T+5, 2:b7), a rail (T+, B-, 2:B+) or a part pin (U1.GPIO8, U2.SDA).`);
}

function resolveGroup(refs, n, design, layout, occ) {
  if (!Array.isArray(refs) || refs.length < 2) fail(`Net ${n} needs at least two endpoints.`);
  return refs.map((r) => {
    try {
      const ep = endpointOf(r, design, layout);
      if (ep.hole && occ.has(ep.hole)) fail(`Hole ${ep.hole} is taken: ${describeOcc(occ.get(ep.hole))}.`);
      return ep;
    } catch (e) {
      if (e instanceof ModelError) throw new ModelError(`Net ${n}: ${e.message}`);
      throw e;
    }
  });
}

// Endpoints are connected when any of their strips already share a net; returns the endpoint sets.
function routeComponents(eps, analysis) {
  const keyOf = (st) => analysis.netByStrip.get(st)?.root ?? st;
  const parent = eps.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i]; return i; };
  const owner = new Map();
  eps.forEach((ep, i) => {
    for (const k of new Set(ep.strips.map(keyOf))) {
      if (owner.has(k)) parent[find(i)] = find(owner.get(k)); else owner.set(k, i);
    }
  });
  const comps = new Map();
  eps.forEach((ep, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(ep); });
  return [...comps.values()];
}

const railLabel = (strip) => { const [k, s] = strip.split(':'); return prefix(+k) + s.slice(0, 2); };

// Power mode: groups that wire every ground pin to a ground rail and every supply pin to a rail of a fitting voltage.
function powerJobs(design, layout, A) {
  const holePt = (h) => { const p = parseHole(h, design, layout); return { x: p.col, y: p.y }; };
  const centre = (strip) => { const pts = stripHoles(strip, design, layout).map(holePt); return { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length }; };
  const nearest = (list, from) => list.sort((a, b) => Math.hypot(centre(a.strip).x - from.x, centre(a.strip).y - from.y) - Math.hypot(centre(b.strip).x - from.x, centre(b.strip).y - from.y) || (a.strip < b.strip ? -1 : 1))[0];
  const railEp = (strips) => ({ label: railLabel(strips[0]), strips, hole: null });
  const labels = (eps) => eps.map((e) => e.label);

  const rails = [];
  for (const B of layout) for (const name of B.rails) {
    const strips = new Set();
    for (let c = 1; c <= B.cols; c++) strips.add(stripOf(parseHole(prefix(B.index) + name + c, design, layout), design, layout));
    for (const strip of strips) {
      const net = A.netByStrip.get(strip);
      rails.push({ strip, name, ground: !!net?.ground, volts: net && !net.ground && net.sources.length ? net.sources[0].volts : null });
    }
  }

  const gndEps = [], consumers = [], usb = [];
  for (const L of A.layout.filter((x) => x.lib.kind !== 'rail-module')) {
    const id = L.part.id;
    if (L.pins.some((p) => p.role === 'gnd' || p.role === 'gnd-in')) gndEps.push(endpointOf(`${id}.GND`, design, layout));
    for (const p of L.pins) if (p.role === 'power-in') consumers.push({ ref: `${id}.${p.name}`, min: p.min, max: p.max });
    if (L.lib.mcu) {
      const mode = L.part.props.power;
      if (mode === 'usb') usb.push({ ref: `${id}.3V3`, volts: 3.3 }, { ref: `${id}.5V`, volts: 5 });
      else if (mode === '5v-pin') consumers.push({ ref: `${id}.5V`, min: 5, max: 5 });
      else if (mode === '3v3-pin') consumers.push({ ref: `${id}.3V3`, min: 3.3, max: 3.3 });
    }
  }

  const jobs = [], notes = [];
  if (gndEps.length) {
    let grounded = rails.filter((r) => r.ground);
    if (!grounded.length) {
      const minus = rails.filter((r) => r.name.endsWith('-'));
      grounded = minus.length ? [nearest(minus, centre(gndEps[0].strips[0]))] : [];
    }
    const eps = [...gndEps, ...grounded.map((r) => railEp([r.strip]))];
    if (eps.length > 1) jobs.push({ eps, tag: 'Power', given: labels(eps) });
  }

  if (consumers.length) {
    const avail = new Set([...rails.filter((r) => r.volts !== null).map((r) => r.volts), ...usb.map((u) => u.volts)]);
    if (!avail.size) fail('Nothing here supplies power. Place an MB102 or power the ESP32 over USB.');
    const byVolts = new Map();
    for (const c of consumers) {
      const v = [3.3, 5].find((x) => avail.has(x) && x >= c.min && x <= c.max);
      if (v === undefined) fail(`No supply fits ${c.ref} (${c.min === c.max ? c.min : `${c.min}-${c.max}`} V). Available: ${[...avail].sort((a, b) => a - b).map((x) => `${x} V`).join(', ')}. Use a source in that range or a different part.`);
      if (!byVolts.has(v)) byVolts.set(v, []);
      byVolts.get(v).push(endpointOf(c.ref, design, layout));
    }
    const used = new Set();
    for (const v of [...byVolts.keys()].sort((a, b) => a - b)) {
      const powered = rails.filter((r) => r.volts === v);
      if (powered.length) {
        const eps = [...byVolts.get(v), railEp(powered.map((r) => r.strip))];
        jobs.push({ eps, tag: 'Power', given: labels(eps) });
        continue;
      }
      const src = usb.find((u) => u.volts === v), srcEp = endpointOf(src.ref, design, layout);
      const spare = rails.filter((r) => r.name.endsWith('+') && r.volts === null && !r.ground && !used.has(r.strip));
      if (!spare.length) fail(`No spare + rail to carry ${v} V from ${src.ref}. Use a board with more rails, or wire it by hand.`);
      const rail = nearest(spare, centre(srcEp.strips[0]));
      used.add(rail.strip);
      notes.push(`fed ${railLabel(rail.strip)} from ${src.ref}`);
      const eps = [srcEp, railEp([rail.strip]), ...byVolts.get(v)];
      jobs.push({ eps, tag: 'Power', given: labels(eps) });
    }
  }
  return { jobs, notes };
}

// Mutates `design` as it goes, so a failure part-way leaves it half-routed. Call it only through
// mutate() in server.js, which works on a copy and commits on success.
export function routeNets(design, { nets = [], power = false } = {}) {
  if (!nets.length && !power) fail('Give at least one net, or set power to true.');
  const layout = boardLayout(design);
  const userJobs = nets.map((refs, i) => ({ eps: resolveGroup(refs, i + 1, design, layout, occupancy(design)), tag: `Net ${i + 1}`, given: refs }));
  const wires = [], satisfied = [], notes = [];
  const jobs = [];
  if (power) { const pj = powerJobs(design, layout, analyze(design)); jobs.push(...pj.jobs); notes.push(...pj.notes); }
  jobs.push(...userJobs);
  const at = (h) => parseHole(h, design, layout);
  const centre = (holes) => ({ col: holes.reduce((s, h) => s + at(h).col, 0) / holes.length, y: holes.reduce((s, h) => s + at(h).y, 0) / holes.length });

  jobs.forEach(({ eps, tag, given }) => {
    let added = 0;
    const mine = new Set(); // holes this job's own wires already use
    for (;;) {
      const comps = routeComponents(eps, analyze(design));
      if (comps.length === 1) { if (!added) satisfied.push(given); break; }
      const occ = occupancy(design), avoid = overhangSet(design, layout);
      const free = (strip) => stripHoles(strip, design, layout).filter((h) => !occ.has(h) && !avoid.has(h));
      // Every candidate hole of a component, optionally pruning long strips towards a point.
      const candidates = (comp, toward) => {
        const out = [];
        for (const ep of comp) {
          if (ep.hole && mine.has(ep.hole)) { out.push(...free(ep.strips[0])); continue; } // already wired: any free hole of its strip is the same net
          if (ep.hole) { if (occ.has(ep.hole)) fail(`${tag}: Hole ${ep.hole} is taken: ${describeOcc(occ.get(ep.hole))}.`); out.push(ep.hole); continue; }
          for (const st of ep.strips) {
            let hs = free(st);
            if (toward && hs.length > ROUTE_WEIGHTS.candidates) {
              const d = (h) => Math.hypot(at(h).col - toward.col, at(h).y - toward.y);
              hs = hs.sort((a, b) => d(a) - d(b) || (a < b ? -1 : 1)).slice(0, ROUTE_WEIGHTS.candidates);
            }
            out.push(...hs);
          }
        }
        return [...new Set(out)];
      };
      const all = comps.map((c) => candidates(c, null));
      comps.forEach((c, i) => { if (!all[i].length) fail(`${tag}: No free hole left for ${c[0].label}. Move a part, or use two joined boards.`); });
      let best = null;
      for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) {
        const xs = candidates(comps[i], centre(all[j])), ys = candidates(comps[j], centre(all[i]));
        for (const hx of xs) for (const hy of ys) {
          if (hx === hy) continue;
          const score = scoreWire(design, hx, hy), key = `${hx}|${hy}`;
          if (!best || score < best.score || (score === best.score && key < best.key)) best = { score, key, from: hx, to: hy };
        }
      }
      try { const w = addWire(design, { from: best.from, to: best.to }); wires.push(w); mine.add(w.from).add(w.to); }
      catch (e) { if (e instanceof ModelError) throw new ModelError(`${tag}: ${e.message}`); throw e; }
      added++;
    }
  });
  return { wires, satisfied, notes };
}

// ---------- analysis ----------
class UF {
  constructor() { this.p = new Map(); }
  find(a) { while (this.p.has(a)) a = this.p.get(a); return a; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p.set(b, a); }
}

export function analyze(design) {
  const layoutB = boardLayout(design);
  const H = (id) => parseHole(id, design, layoutB);
  const S = (id) => stripOf(H(id), design, layoutB);
  const checks = [];
  const add = (level, code, message, holes = []) => checks.push({ level, code, message, holes });
  const layout = [];
  for (const part of design.parts) {
    try { layout.push({ part, lib: LIBRARY[part.type], ...footprint(part, design, layoutB) }); }
    catch (e) { add('error', 'bad-placement', e.message); }
  }

  const uf = new UF();
  for (const w of design.wires) if (H(w.from) && H(w.to)) uf.union(S(w.from), S(w.to));
  for (const L of layout) for (const tie of L.lib.ties || []) {
    const ps = L.pins.filter((p) => p.label === tie);
    for (let i = 1; i < ps.length; i++) uf.union(S(ps[0].hole), S(ps[i].hole));
  }
  const nets = new Map();
  const netFor = (strip) => {
    const r = uf.find(strip);
    if (!nets.has(r)) nets.set(r, { root: r, strips: new Set(), pins: [], wires: [], sources: [], ground: false });
    const n = nets.get(r); n.strips.add(strip); return n;
  };
  for (const L of layout) for (const pin of L.pins) { pin.part = L.part.id; pin.net = netFor(S(pin.hole)); pin.net.pins.push(pin); }
  for (const w of design.wires) {
    if (!H(w.from) || !H(w.to)) { add('error', 'bad-wire', `Wire ${w.id} has an end that isn't a hole on this design (${w.from} → ${w.to}).`); continue; }
    const n = netFor(S(w.from)); netFor(S(w.to)); n.wires.push(w.id);
  }

  // supplies
  const mcus = layout.filter((L) => L.lib.mcu);
  for (const L of layout) {
    if (L.lib.kind === 'rail-module') for (const pin of L.pins) {
      if (pin.role === 'gnd') pin.net.ground = true;
      else { const v = L.part.props[pin.side === 'T' ? 'top' : 'bottom']; if (v !== 'off') pin.net.sources.push({ volts: v === '5V' ? 5 : 3.3, by: `${L.part.id}.${pin.key}` }); }
    }
    if (L.lib.mcu) for (const pin of L.pins) if (pin.role === 'gnd') pin.net.ground = true;
  }
  const pinOf = (L, label) => L.pins.find((p) => p.label === label);
  const powered = new Map();
  for (const L of mcus) if (L.part.props.power === 'usb') {
    powered.set(L.part.id, true);
    pinOf(L, '3V3').net.sources.push({ volts: 3.3, by: `${L.part.id}.3V3` });
    pinOf(L, '5V').net.sources.push({ volts: 5, by: `${L.part.id}.5V` });
  }
  for (const L of mcus) {
    const mode = L.part.props.power, p3 = pinOf(L, '3V3'), p5 = pinOf(L, '5V');
    if (mode === '5v-pin') {
      const ok = p5.net.sources.some((s) => s.volts === 5); powered.set(L.part.id, ok);
      if (ok) p3.net.sources.push({ volts: 3.3, by: `${L.part.id}.3V3` });
    } else if (mode === '3v3-pin') powered.set(L.part.id, p3.net.sources.some((s) => s.volts === 3.3));
  }

  const netList = [...nets.values()].filter((n) => n.pins.length || n.wires.length);
  const netByStrip = new Map();
  for (const n of netList) for (const s of n.strips) netByStrip.set(s, n);
  let gnd = 0;
  netList.forEach((n, i) => {
    n.index = i;
    if (n.ground) n.name = ++gnd === 1 ? 'GND' : `GND ${gnd}`;
    else if (n.sources.length) n.name = n.sources[0].volts === 5 ? '5V' : '3V3';
    else if (n.pins.some((p) => p.role === 'sda')) n.name = 'SDA';
    else if (n.pins.some((p) => p.role === 'scl')) n.name = 'SCL';
    else { const g = n.pins.find((p) => p.role === 'gpio'); n.name = g ? g.name : `N${i + 1}`; }
    n.volts = n.ground ? 0 : n.sources.length ? n.sources[0].volts : null;
    n.driven = n.ground || n.sources.length > 0 || n.pins.some((p) => p.role === 'gpio');
  });
  const ref = (p) => `${p.part}.${p.name}`;
  const holesOf = (n, pred = () => true) => n.pins.filter(pred).map((p) => p.hole);

  // physical
  const holeOwner = new Map(), coveredBy = new Map(), overhangBy = new Map();
  for (const L of layout) { for (const h of L.covered) coveredBy.set(h, L.part.id); for (const h of L.overhang) overhangBy.set(h, L.part.id); }
  for (const L of layout) for (const p of L.pins) {
    if (holeOwner.has(p.hole)) add('error', 'hole-clash', `${ref(p)} and ${holeOwner.get(p.hole)} are in the same hole ${p.hole}.`, [p.hole]);
    else holeOwner.set(p.hole, ref(p));
    const c = coveredBy.get(p.hole);
    if (c && c !== L.part.id) add('error', 'under-board', `${ref(p)} is in ${p.hole}, which is under ${c}'s board.`, [p.hole]);
    const o = overhangBy.get(p.hole);
    if (o && o !== L.part.id) add('warning', 'under-psu', `${ref(p)} at ${p.hole} is probably under the power module ${o}. Move it a few columns away.`, [p.hole]);
  }
  const wireEnds = new Map();
  for (const w of design.wires) for (const h of [w.from, w.to]) {
    if (holeOwner.has(h)) add('error', 'hole-clash', `Wire ${w.id} ends in ${h}, where ${holeOwner.get(h)} already is.`, [h]);
    if (wireEnds.has(h)) add('error', 'hole-clash', `Wires ${wireEnds.get(h)} and ${w.id} both end in ${h}.`, [h]);
    wireEnds.set(h, w.id);
    if (coveredBy.has(h)) add('warning', 'wire-under-board', `Wire ${w.id} ends in ${h}, under ${coveredBy.get(h)}'s board. Only a flat jumper fitted first would work.`, [h]);
    if (overhangBy.has(h)) add('warning', 'under-psu', `Wire ${w.id} ends in ${h}, probably under the power module ${overhangBy.get(h)}.`, [h]);
  }
  for (const L of layout) {
    const byStrip = new Map();
    for (const p of L.pins) { if (p.role === 'nc') continue; const s = S(p.hole); (byStrip.get(s) || byStrip.set(s, []).get(s)).push(p); }
    for (const [s, ps] of byStrip) if (new Set(ps.map((p) => p.label)).size > 1) {
      const isButton = L.lib.kind === 'tactile';
      add('error', 'strip-short', isButton
        ? `${L.part.id}'s two sides share ${describeStrip(s, design)}, so the button is always closed.`
        : `${L.part.id}'s ${ps.map((p) => p.name).join(' and ')} share ${describeStrip(s, design)}, which shorts them together.`, ps.map((p) => p.hole));
    }
  }
  for (const L of mcus) {
    const nc = L.pins.filter((p) => p.role === 'nc' && p.net.pins.length + p.net.wires.length > 1);
    for (const p of nc) add('info', 'nc-pin', `${L.part.id} ${p.key} is a no-connect pin; anything wired to its strip isn't connected to the board.`, [p.hole]);
  }

  // supplies and shorts
  for (const n of netList) {
    if (n.ground && n.sources.length) add('error', 'short', `Short circuit: ${n.sources.map((s) => s.by).join(', ')} is connected straight to ground.`, holesOf(n));
    const volts = [...new Set(n.sources.map((s) => s.volts))];
    if (volts.length > 1) add('error', 'supply-clash', `${n.sources.map((s) => `${s.by} (${s.volts} V)`).join(' and ')} are tied together. Two supply voltages on one net will damage something.`, holesOf(n));
    else if (n.sources.length > 1 && !n.ground) add('warning', 'double-supply', `${n.sources.map((s) => s.by).join(' and ')} both drive the same ${volts[0]} V net. Supplies fighting each other can back-feed; power it from one source.`, holesOf(n));
  }
  for (const L of mcus) {
    const id = L.part.id, mode = L.part.props.power, p3 = pinOf(L, '3V3'), p5 = pinOf(L, '5V');
    const ext = (pin) => pin.net.sources.filter((s) => !s.by.startsWith(id + '.'));
    if (mode === 'usb') {
      for (const pin of [p5, p3]) if (ext(pin).length) add('warning', 'mcu-backfeed', `${id} is powered from USB, but ${ext(pin).map((s) => s.by).join(', ')} also feeds its ${pin.label} pin. Espressif lists USB, the 5V pin and the 3V3 pin as mutually exclusive power options.`, [pin.hole]);
    } else if (!powered.get(id)) add('error', 'mcu-unpowered', `${id} is set to be powered through its ${mode === '5v-pin' ? '5V' : '3V3'} pin, but nothing supplies ${mode === '5v-pin' ? '5' : '3.3'} V to it.`, [(mode === '5v-pin' ? p5 : p3).hole]);
    if (mode === '3v3-pin' && ext(p5).length) add('warning', 'mcu-backfeed', `${id} is fed through 3V3 and also has a supply on its 5V pin. Use one power input only.`, [p5.hole]);
    if (mode === '5v-pin' && ext(p3).length) add('warning', 'mcu-backfeed', `${id} is fed through 5V and also has ${ext(p3).map((s) => s.by).join(', ')} on its 3V3 pin. Use one power input only.`, [p3.hole]);
  }
  for (const L of layout) for (const p of L.pins) {
    if (p.role !== 'power-in' || p.net.ground) continue;
    if (!p.net.sources.length) add('error', 'unpowered', `${ref(p)} isn't connected to a supply.`, [p.hole]);
    else {
      const v = p.net.sources[0].volts;
      if (v > p.max) add('error', 'overvoltage', `${ref(p)} gets ${v} V but takes at most ${p.max} V.${L.part.type === 'bme280-3v3' ? ' This BME280 board has no regulator: feed it from 3.3 V.' : ''}`, [p.hole]);
      if (v < p.min) add('error', 'undervoltage', `${ref(p)} gets ${v} V but needs at least ${p.min} V.`, [p.hole]);
    }
  }

  // grounds
  const gndPins = layout.flatMap((L) => L.pins.filter((p) => p.role === 'gnd' || p.role === 'gnd-in'));
  for (const p of gndPins) if (p.role === 'gnd-in' && !p.net.ground) add('error', 'no-ground', `${ref(p)} isn't connected to ground.`, [p.hole]);
  const gndNets = [...new Set(gndPins.filter((p) => p.net.ground).map((p) => p.net))];
  if (gndNets.length > 1) add('error', 'split-ground', `The grounds aren't joined: ${gndNets.map((n) => `${n.name} (${[...new Set(n.pins.filter((p) => /gnd/.test(p.role)).map((p) => p.part))].join(', ')})`).join(' and ')}. Everything needs a common ground.`, gndNets.flatMap((n) => holesOf(n, (p) => /gnd/.test(p.role))));

  // GPIO use
  const usedGpio = new Map();
  const noteGpio = (gpioPin, purpose) => {
    const L = layout.find((x) => x.part.id === gpioPin.part);
    const key = `${gpioPin.part}.${gpioPin.gpio}`;
    if (usedGpio.has(key)) return; usedGpio.set(key, true);
    for (const note of L.lib.gpioNotes(L.part.props)) if (note.gpios.includes(gpioPin.gpio)) add(note.level, 'gpio-' + note.level, `${L.part.id} GPIO${gpioPin.gpio} (${purpose}) ${note.text}.`, [gpioPin.hole]);
  };
  for (const n of netList) {
    const gpios = n.pins.filter((p) => p.role === 'gpio');
    if (gpios.length > 1) add('error', 'gpio-short', `${gpios.map(ref).join(' and ')} are connected together.`, gpios.map((p) => p.hole));
    if (gpios.length && (n.ground || n.sources.length)) add('error', 'gpio-power', `${gpios.map(ref).join(', ')} is connected straight to ${n.name}.`, gpios.map((p) => p.hole));
  }

  // I2C
  const buses = new Map();
  const firmware = [];
  for (const L of layout.filter((x) => x.pins.some((p) => p.role === 'sda'))) {
    const sda = L.pins.find((p) => p.role === 'sda'), scl = L.pins.find((p) => p.role === 'scl');
    const g = {};
    for (const p of [sda, scl]) {
      const gp = p.net.pins.filter((x) => x.role === 'gpio');
      if (!gp.length) add('error', 'i2c-unconnected', `${ref(p)} isn't connected to a microcontroller GPIO.`, [p.hole]);
      else if (gp.length === 1) { g[p.role] = gp[0]; noteGpio(gp[0], `I²C ${p.role.toUpperCase()}`); }
    }
    if (sda.net === scl.net) add('error', 'i2c-short', `${L.part.id}'s SDA and SCL are connected together.`, [sda.hole, scl.hole]);
    const csb = L.pins.find((p) => p.role === 'csb');
    if (csb) {
      if (csb.net.ground) add('error', 'csb-low', `${ref(csb)} is tied to ground, which puts the BME280 in SPI mode. Leave it unconnected or tie it to 3.3 V for I²C.`, [csb.hole]);
      else if (!csb.net.sources.length && csb.net.pins.length === 1 && !csb.net.wires.length) add('info', 'csb-float', `${ref(csb)} is unconnected. Many boards pull it up for I²C; if the sensor isn't found, tie CSB to 3.3 V.`, [csb.hole]);
    }
    const addr = L.lib.address ? L.lib.address(L) : null;
    if (g.sda && g.scl) {
      const key = `${g.sda.part}:${g.sda.gpio}:${g.scl.gpio}`;
      if (!buses.has(key)) buses.set(key, { mcu: g.sda.part, sda: g.sda.gpio, scl: g.scl.gpio, devices: [] });
      buses.get(key).devices.push({ part: L.part.id, kind: L.lib.short, address: addr?.value, note: addr?.note, holes: [sda.hole, scl.hole] });
    }
  }
  for (const b of buses.values()) {
    const fixed = b.devices.filter((d) => /^0x[0-9A-F]+$/i.test(d.address || ''));
    const seen = new Map();
    for (const d of fixed) { if (seen.has(d.address)) add('warning', 'i2c-address', `${seen.get(d.address)} and ${d.part} both use I²C address ${d.address} on the same bus.`, d.holes); seen.set(d.address, d.part); }
    firmware.push(b);
    add('info', 'firmware', `${b.mcu} I²C bus: Wire.begin(${b.sda}, ${b.scl}); ${b.devices.map((d) => `${d.part} ${d.kind} at ${d.address}${d.note ? ` (${d.note})` : ''}`).join('; ')}.`, b.devices.flatMap((d) => d.holes));
  }

  // LEDs and buttons
  for (const L of layout.filter((x) => x.part.type === 'led')) {
    const A = L.pins.find((p) => p.role === 'led-a'), K = L.pins.find((p) => p.role === 'led-k');
    if (A.net === K.net) add('error', 'led-shorted', `${L.part.id}'s legs are on the same net, so it can never light.`, [A.hole, K.hole]);
    else if (K.net.driven && !K.net.ground && A.net.ground) add('error', 'led-backwards', `${L.part.id} is in backwards: its anode (long leg) is on ground. Swap at and to.`, [A.hole, K.hole]);
    else if (A.net.driven && K.net.ground) add('warning', 'led-no-resistor', `${L.part.id} goes straight from ${A.net.name} to ground with no series resistor, which will burn it out or overload the pin. Add a resistor (220–1k Ω).`, [A.hole, K.hole]);
    else if (!A.net.driven && A.net.pins.length + A.net.wires.length <= 1 || !K.net.driven && K.net.pins.length + K.net.wires.length <= 1) add('info', 'led-open', `${L.part.id} isn't in a complete circuit yet.`, [A.hole, K.hole]);
  }
  for (const L of layout.filter((x) => x.lib.kind === 'tactile')) {
    const n1 = L.pins.find((p) => p.label === '1').net, n2 = L.pins.find((p) => p.label === '2').net;
    const gp = [...n1.pins, ...n2.pins].find((p) => p.role === 'gpio');
    const other = gp ? (gp.net === n1 ? n2 : n1) : null;
    if ((n1.ground && n2.sources.length) || (n2.ground && n1.sources.length)) add('error', 'button-short', `${L.part.id} connects a supply straight to ground when pressed.`, L.pins.map((p) => p.hole));
    else if (gp && other?.ground) { add('info', 'button', `${L.part.id} pulls ${gp.part} GPIO${gp.gpio} to ground when pressed: use pinMode(${gp.gpio}, INPUT_PULLUP) and read LOW as pressed.`, L.pins.map((p) => p.hole)); noteGpio(gp, 'button'); }
    else if (gp && other?.sources.length) { add('info', 'button', `${L.part.id} pulls ${gp.part} GPIO${gp.gpio} high when pressed: use INPUT_PULLDOWN or add a pull-down resistor.`, L.pins.map((p) => p.hole)); noteGpio(gp, 'button'); }
  }

  const notes = new Set();
  for (const L of mcus) if (L.lib.spacingNote && !notes.has(L.part.type)) { notes.add(L.part.type); add('info', 'assumption', `${L.lib.short}: ${L.lib.spacingNote}`); }
  if (design.boards.length > 1 && design.boards.some((b) => typeof b.offset !== 'number')) add('info', 'assumption', 'Joined boards are assumed to put board 2\'s row a 1.3 in below board 1\'s row a (facing rails removed, boards pushed together). Measure your pair and set the offset if a module doesn\'t line up.');

  const order = { error: 0, warning: 1, info: 2 };
  checks.sort((a, b) => order[a.level] - order[b.level]);
  return { layout, nets: netList, netByStrip, checks, firmware };
}

// ---------- summaries ----------
export function summarizeChecks(a) {
  const c = { error: 0, warning: 0, info: 0 };
  for (const x of a.checks) c[x.level]++;
  return `${c.error} error${c.error === 1 ? '' : 's'}, ${c.warning} warning${c.warning === 1 ? '' : 's'}, ${c.info} note${c.info === 1 ? '' : 's'}`;
}
export function describeBoards(design) {
  return boardLayout(design).map((B) => `Board ${B.index}: ${SIZES[B.size].label}, rails ${B.rails.length ? B.rails.join(' ') : 'none'}${B.splitRails ? ' (split)' : ''}${B.index > 1 ? `, holes written ${B.index}:a12` : ''}`);
}
export function describeDesign(design) {
  const a = analyze(design);
  return {
    name: design.name,
    boards: describeBoards(design),
    parts: a.layout.map((L) => ({
      id: L.part.id, type: L.part.type, at: L.part.at, rotation: L.part.rotation, ...(L.part.to ? { to: L.part.to } : {}), props: L.part.props,
      pins: L.pins.map((p) => `${p.key} ${p.name} @ ${p.hole} [${p.net.name}]`),
      ...(L.covered.length ? { covers: `${L.covered.length} holes between its headers` } : {}),
    })),
    wires: design.wires.map((w) => `${w.id} ${w.from} → ${w.to} (${w.color})`),
    status: summarizeChecks(a),
  };
}
export function describeNets(design) {
  const a = analyze(design);
  return a.nets.map((n) => ({
    name: n.name, ...(n.volts !== null ? { volts: n.volts } : {}),
    pins: n.pins.map((p) => `${p.part}.${p.name} (${p.hole})`),
    strips: [...n.strips].map((s) => describeStrip(s, design)), wires: n.wires,
  }));
}
export function boardInfo(design) {
  return {
    units: 'One pitch = 0.1 in. Columns are numbered from 1.',
    current: describeBoards(design),
    holes: 'Main holes are a1–j63: rows a–e are the top half, f–j the bottom half, with the centre gap between. Rails: T- (outer top), T+ (inner top), B+ (inner bottom), B- (outer bottom), numbered by column, e.g. T+5. Holes on board 2 take a prefix: 2:a12, 2:B-5.',
    connections: 'In each column, holes a–e connect, and f–j connect. Each rail is one connection along its length (split rails break in the middle). Separate boards are not connected unless wired.',
    wiring: 'add_wires ends can be a hole, a rail (T+, or 2:B- to pick a board; nearest free hole) or a part pin (U1.GPIO8, U2.SDA; a free hole in that pin\'s strip). Each hole holds one lead.',
    layouts: 'ESP32 DevKitC boards cover the holes between their headers. On one board only one header stays reachable. new_design with boards: 2 gives two boards pushed together with the facing rails removed: put the first header (J1, or J2 on the classic ESP32) in row d or e of board 1 (rotation 0) and J3 lands in row a or b of board 2, leaving free holes on both sides. A power module needs a board with both rail pairs, so a joined pair is usually powered over USB.',
  };
}
export function listParts() {
  return Object.entries(LIBRARY).map(([type, l]) => ({
    type, name: l.name, kind: l.kind, description: l.description,
    pins: l.kind === 'dual-header' ? Object.fromEntries(headerNames(l).map((h) => [h, l.headers[h].join(' ')]))
      : l.kind === 'rail-module' ? RAILS.join(' ')
        : l.kind === 'two-lead' ? l.leads.map((x) => `${x.key} (${x.name})`).join(', ')
          : l.kind === 'tactile' ? '1a 1b (left, always joined), 2a 2b (right, always joined)'
            : l.pins.map((p) => p.key).join(' '),
    props: Object.fromEntries(Object.entries(l.props || {}).map(([k, s]) => [k, { default: s.default, ...(s.options ? { options: s.options } : {}), help: s.help }])),
  }));
}

// ---------- view model for the browser ----------
export function buildView(design, extra = {}) {
  const a = analyze(design), layout = boardLayout(design);
  const holeNet = {};
  for (const n of a.nets) for (const s of n.strips) for (const h of stripHoles(s, design, layout)) holeNet[h] = n.index;
  return {
    ...extra,
    name: design.name,
    boards: layout.map((B) => ({ index: B.index, cols: B.cols, rails: B.rails, oy: B.oy, top: B.top, bottom: B.bottom, splitRails: B.splitRails })),
    holes: allHoles(design, layout).map((h) => [h.id, h.col, h.y]),
    parts: a.layout.map((L) => ({
      id: L.part.id, type: L.part.type, kind: L.lib.kind, short: L.lib.short, at: L.part.at, to: L.part.to, rotation: L.part.rotation,
      props: L.part.props, propSpec: Object.fromEntries(Object.entries(L.lib.props || {}).filter(([, s]) => s.options).map(([k, s]) => [k, s.options])),
      body: L.body, overhang: L.overhang,
      pins: L.pins.map((p) => ({ key: p.key, label: p.label, name: p.name, role: p.role, hole: p.hole, net: p.net.index })),
    })),
    wires: design.wires.map((w) => ({ id: w.id, from: w.from, to: w.to, color: w.color, net: holeNet[w.from] })),
    holeNet,
    nets: a.nets.map((n) => ({ index: n.index, name: n.name, volts: n.volts, pins: n.pins.map((p) => `${p.part}.${p.name}`) })),
    checks: a.checks.map(({ level, code, message, holes }) => ({ level, code, message, holes })),
    summary: summarizeChecks(a),
    colors: WIRE_COLORS,
  };
}
