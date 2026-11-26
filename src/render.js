// Headless SVG and PNG renderer for Breadboard Bench designs.
// Uses the same geometry and palettes as public/index.html so agents see what humans see in the viewer.
import { Resvg } from '@resvg/resvg-js';
import * as M from './model.js';

const P = 16;
const MX = 40;
const PAD_TOP = 24;
const PAD_BOTTOM = 24;
const HEADER_H = 40;
const FOOTER_ROW_H = 18;
const LANE = 3;

export const BOARD_PALETTES = {
  cream: { name: 'Cream', body: '#EEEBE2', edge: '#CDC8B7', rail: '#E6E2D6', channel: '#DAD5C6', hole: '#3D3B36', label: '#787364', tag: '#8F8A7A', plus: '#C8322E', minus: '#2C5DA8', mat: '#B7C6C2', ink: '#1B2829', inkSoft: '#4A5C5D' },
  white: { name: 'White', body: '#F7F7F5', edge: '#D5D5D0', rail: '#EFEFEC', channel: '#E2E2DE', hole: '#3D3B36', label: '#7A7A74', tag: '#94948E', plus: '#C8322E', minus: '#2C5DA8', mat: '#C5D0CD', ink: '#1B2829', inkSoft: '#4A5C5D' },
  green: { name: 'Green', body: '#3F7A4E', edge: '#2D5A39', rail: '#386E46', channel: '#2F6240', hole: '#E9F2E4', label: '#D4E6D2', tag: '#B5D2B6', plus: '#FFB4AE', minus: '#B9D2FF', mat: '#253531', ink: '#E6EFEA', inkSoft: '#A7BCB5' },
  blue: { name: 'Blue', body: '#3B5F9A', edge: '#2A4675', rail: '#345489', channel: '#2C4A7F', hole: '#E8EEF9', label: '#D3DEF3', tag: '#B4C6E6', plus: '#FFB4AE', minus: '#C4DAFF', mat: '#202B3A', ink: '#E8EEF8', inkSoft: '#A5B6CE' },
  red: { name: 'Red', body: '#A83A36', edge: '#7E2A27', rail: '#9B332F', channel: '#8A2D2A', hole: '#FBEAE6', label: '#F5D3CE', tag: '#E8B4AE', plus: '#FFE0DC', minus: '#C4DAFF', mat: '#352222', ink: '#F7EAE8', inkSoft: '#CBB1AD' },
  black: { name: 'Black', body: '#2A2B2E', edge: '#161719', rail: '#232427', channel: '#1D1E20', hole: '#C9CCD1', label: '#A4A8AF', tag: '#8A8E96', plus: '#FF6B64', minus: '#6FA3FF', halo: true, mat: '#1A2324', ink: '#E2EAE8', inkSoft: '#9DAFAD' },
};
export const BOARD_COLORS = Object.keys(BOARD_PALETTES);

const WIRE_HEX = {
  red: '#D2302C', black: '#2B2B2B', orange: '#EE7B22', yellow: '#E8B81E',
  green: '#2E9E46', blue: '#2C6BD6', purple: '#7D3FB8', white: '#F5F5F2', grey: '#8A8F96',
};
const LED_FILL = { red: '#D8322B', green: '#2DA84A', yellow: '#E9B51C', blue: '#2E66D8', white: '#E4E8EE' };
const EIA_DIGIT = ['#1C1C1C', '#7B431E', '#CC2929', '#E67E22', '#E8C61E', '#2E9E46', '#2B6CB0', '#7D3FB8', '#7F8C8D', '#F4F4F0'];
const FONT = 'DejaVu Sans, Liberation Sans, Arial, sans-serif';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function formatOhms(ohms) {
  if (ohms >= 1e6) return `${+(ohms / 1e6).toFixed(2)}MΩ`;
  if (ohms >= 1e3) return `${+(ohms / 1e3).toFixed(2)}kΩ`;
  return `${+Number(ohms).toFixed(1)}Ω`;
}

function resistorBands(ohms) {
  const n = Number(ohms);
  if (!(n > 0)) return ['#7B431E', '#1C1C1C', '#E67E22', '#D4AF37'];
  let val = n, mult = 0;
  while (val >= 100) { val /= 10; mult++; }
  while (val < 10 && mult > -2) { val *= 10; mult--; }
  const r = Math.round(val);
  const d1 = Math.min(9, Math.max(0, Math.floor(r / 10)));
  const d2 = Math.min(9, Math.max(0, r % 10));
  const mColor = mult === -1 ? '#D4AF37' : mult === -2 ? '#C0C0C0' : (EIA_DIGIT[Math.min(9, Math.max(0, mult))] || '#7B431E');
  return [EIA_DIGIT[d1], EIA_DIGIT[d2], mColor, '#D4AF37'];
}

function planLanes(wires, holeXY) {
  const lanes = new Map();
  const byRow = new Map();
  for (const w of wires) {
    const A = holeXY.get(w.from), B = holeXY.get(w.to);
    if (!A || !B) continue;
    const [L0, R0] = A.x <= B.x ? [A, B] : [B, A];
    if (L0.x === R0.x || L0.y === R0.y) continue;
    const key = R0.y;
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push({ id: w.id, x0: L0.x, x1: R0.x });
  }
  for (const group of byRow.values()) {
    const placed = [];
    for (const it of group.sort((a, b) => a.x0 - b.x0 || a.id.localeCompare(b.id))) {
      let lane = 0;
      while (placed.some((q) => q.lane === lane && q.x1 > it.x0 && it.x1 > q.x0)) lane++;
      placed.push({ ...it, lane });
      lanes.set(it.id, lane ? (lane % 2 ? 1 : -1) * Math.ceil(lane / 2) * LANE : 0);
    }
  }
  return lanes;
}

function wireGeometry(A, B, id, tidy, lanes) {
  if (tidy) {
    const [L0, R0] = A.x <= B.x ? [A, B] : [B, A];
    if (L0.x === R0.x || L0.y === R0.y) {
      return { d: `M${A.x} ${A.y} L${B.x} ${B.y}`, mid: { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 } };
    }
    const y = R0.y + (lanes.get(id) || 0);
    return {
      d: `M${L0.x} ${L0.y} L${L0.x} ${y} L${R0.x} ${y} L${R0.x} ${R0.y}`,
      mid: { x: (L0.x + R0.x) / 2, y },
    };
  }
  const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1, k = Math.min(len * 0.14, 26);
  const cx = (A.x + B.x) / 2 - (dy / len) * k;
  const cy = (A.y + B.y) / 2 + (dx / len) * k;
  // Midpoint on quadratic Bezier at t = 0.5
  return {
    d: `M${A.x} ${A.y} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${B.x} ${B.y}`,
    mid: { x: 0.25 * A.x + 0.5 * cx + 0.25 * B.x, y: 0.25 * A.y + 0.5 * cy + 0.25 * B.y },
  };
}

export function renderSvg(design, options = {}) {
  const {
    boardColor = 'cream',
    tidy = false,
    showChecks = true,
    showLabels = true,
    showWireIds = false,
    header = true,
  } = options;

  const C = BOARD_PALETTES[boardColor] || BOARD_PALETTES.cream;
  const analysis = M.analyze(design);
  const state = M.buildView(design);
  const metrics = M.layoutMetrics(design, analysis);

  const bs = state.boards;
  const maxCols = Math.max(...bs.map((b) => b.cols));
  const minY = bs[0].oy + bs[0].top;
  const last = bs[bs.length - 1];
  const topOffset = header ? HEADER_H + PAD_TOP : PAD_TOP;
  const X = (c) => MX + (c - 1) * P;
  const Y = (y) => topOffset + (y - minY) * P;

  const boardW = MX * 2 + (maxCols - 1) * P;
  const boardBottomY = Y(last.oy + last.bottom);

  const flaggedChecks = showChecks ? state.checks.filter((c) => c.level === 'error' || c.level === 'warning') : [];
  const shownChecks = flaggedChecks.slice(0, 6);
  const overflowChecks = Math.max(0, flaggedChecks.length - shownChecks.length);
  const footerH = shownChecks.length ? (shownChecks.length + (overflowChecks ? 1 : 0)) * FOOTER_ROW_H + 18 : 0;

  const W = boardW;
  const H = Math.ceil(boardBottomY + PAD_BOTTOM + footerH);

  const holeXY = new Map();
  for (const [id, col, y] of state.holes) holeXY.set(id, { x: X(col), y: Y(y), col, gy: y });

  const txt = (x, y, s, fill, size, weight = 600, anchor = 'middle') =>
    `<text x="${x}" y="${y}" dy="0.35em" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" font-family="${FONT}">${esc(s)}</text>`;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  // Mat background
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${C.mat}"/>`);

  // Header bar
  if (header) {
    const errN = state.checks.filter((c) => c.level === 'error').length;
    const warnN = state.checks.filter((c) => c.level === 'warning').length;
    const pillBg = errN > 0 ? '#B3261E' : warnN > 0 ? '#B26B00' : '#257942';
    const boardDesc = bs.length > 1
      ? `${bs.length} boards (${bs[0].cols} cols)`
      : (bs[0].cols === 63 ? 'Full-size (63 cols)' : 'Half-size (30 cols)');
    const meta = `${boardDesc} · ${metrics.parts} part${metrics.parts === 1 ? '' : 's'} · ${metrics.wires} wire${metrics.wires === 1 ? '' : 's'}${tidy ? ' · tidy' : ''}`;
    const pillText = errN === 0 && warnN === 0
      ? 'OK · 0 errors, 0 warnings'
      : `${errN} error${errN === 1 ? '' : 's'}, ${warnN} warning${warnN === 1 ? '' : 's'}`;
    const neatText = `${metrics.wireCrossings} crossing${metrics.wireCrossings === 1 ? '' : 's'}${metrics.wiresOverParts.length ? ` · ${metrics.wiresOverParts.length} over part` : ''}`;

    parts.push(`<rect x="0" y="0" width="${W}" height="${HEADER_H}" fill="${C.halo ? '#141B1C' : '#DCE5E2'}"/>`);
    parts.push(`<line x1="0" y1="${HEADER_H}" x2="${W}" y2="${HEADER_H}" stroke="${C.halo ? '#2C3B3D' : '#AABBB6'}" stroke-width="1"/>`);
    parts.push(txt(16, HEADER_H / 2 - 5, state.name || 'Breadboard Bench', C.ink, 13, 700, 'start'));
    parts.push(txt(16, HEADER_H / 2 + 10, meta, C.inkSoft, 9.5, 500, 'start'));

    const pillW = Math.max(138, pillText.length * 6.3 + 20);
    const pillX = W - 14 - pillW;
    parts.push(`<rect x="${pillX}" y="9" width="${pillW}" height="22" rx="11" fill="${pillBg}"/>`);
    parts.push(txt(pillX + pillW / 2, 20, pillText, '#FFFFFF', 9.5, 700, 'middle'));
    parts.push(txt(pillX - 12, 20, neatText, C.inkSoft, 9.5, 600, 'end'));
  }

  // Boards
  for (const b of bs) {
    const bw = MX * 2 + (b.cols - 1) * P - 12;
    const y0 = Y(b.oy + b.top), y1 = Y(b.oy + b.bottom);
    parts.push(`<rect x="6" y="${y0}" width="${bw}" height="${y1 - y0}" rx="10" fill="${C.body}" stroke="${C.edge}" stroke-width="1.5"/>`);
    if (b.rails.includes('T+')) parts.push(`<rect x="6" y="${y0}" width="${bw}" height="${Y(b.oy - 1.2) - y0}" rx="10" fill="${C.rail}"/>`);
    if (b.rails.includes('B+')) parts.push(`<rect x="6" y="${Y(b.oy + 12.2)}" width="${bw}" height="${y1 - Y(b.oy + 12.2)}" rx="10" fill="${C.rail}"/>`);
    parts.push(`<rect x="14" y="${Y(b.oy + 5.2)}" width="${bw - 16}" height="${P * 0.6}" rx="2" fill="${C.channel}"/>`);

    const railLine = (ry, color) => {
      const yy = Y(b.oy + ry);
      if (b.splitRails) {
        const half = Math.ceil(b.cols / 2);
        const xMidL = X(half) + 4, xMidR = X(half + 1) - 4;
        parts.push(`<line x1="${X(1) - 8}" y1="${yy}" x2="${xMidL}" y2="${yy}" stroke="${color}" stroke-width="2" opacity=".85"/>`);
        parts.push(`<line x1="${xMidR}" y1="${yy}" x2="${X(b.cols) + 8}" y2="${yy}" stroke="${color}" stroke-width="2" opacity=".85"/>`);
      } else {
        parts.push(`<line x1="${X(1) - 8}" y1="${yy}" x2="${X(b.cols) + 8}" y2="${yy}" stroke="${color}" stroke-width="2" opacity=".85"/>`);
      }
    };
    if (b.rails.includes('T+')) { railLine(-4.2, C.minus); railLine(-1.8, C.plus); }
    if (b.rails.includes('B+')) { railLine(12.8, C.plus); railLine(15.2, C.minus); }

    for (const r of b.rails) {
      const c = r[1] === '+' ? C.plus : C.minus;
      const g = r[1] === '+' ? '+' : '−';
      parts.push(txt(20, Y(b.oy + M.RAIL_Y[r]), g, c, 13, 700));
      parts.push(txt(X(b.cols) + 20, Y(b.oy + M.RAIL_Y[r]), g, c, 13, 700));
    }
    for (const [r, y] of Object.entries(M.ROW_Y)) {
      parts.push(txt(20, Y(b.oy + y), r, C.label, 9.5, 500));
      parts.push(txt(X(b.cols) + 20, Y(b.oy + y), r, C.label, 9.5, 500));
    }
    for (let c = 1; c <= b.cols; c++) {
      if (c === 1 || c % 5 === 0) {
        if (b.rails.includes('T+')) parts.push(txt(X(c), Y(b.oy - 1.25), c, C.label, 8.5, 500));
        if (b.rails.includes('B+')) parts.push(txt(X(c), Y(b.oy + 12.25), c, C.label, 8.5, 500));
      }
    }
    if (bs.length > 1) parts.push(txt(X(b.cols) - 34, Y(b.oy + 5.5), `board ${b.index}`, C.tag, 8.5, 600));
  }

  // Holes
  for (const [id] of state.holes) {
    const p = holeXY.get(id);
    parts.push(`<rect x="${p.x - 3}" y="${p.y - 3}" width="6" height="6" rx="1.4" fill="${C.hole}"/>`);
  }

  // Overhang shading
  for (const p of state.parts) {
    for (const h of p.overhang) {
      const q = holeXY.get(h);
      if (q) parts.push(`<rect x="${q.x - 6}" y="${q.y - 6}" width="12" height="12" rx="2" fill="#22334F" opacity=".12"/>`);
    }
  }

  // Part bodies (non-two-lead first, then two-lead passives)
  for (const p of state.parts) {
    if (p.body) {
      const b = p.body;
      const x0 = X(b.c0), x1 = X(b.c1), y0 = Y(b.y0), y1 = Y(b.y1);
      const w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      if (p.kind === 'dual-header') {
        parts.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="6" fill="#1F232B" stroke="#0E1014" stroke-width="1"/>`);
        const left = b.pin1End === 'left', canW = Math.min(w * 0.4, 9 * P);
        const canX = left ? x0 + 1.4 * P : x1 - 1.4 * P - canW;
        parts.push(`<rect x="${canX}" y="${y0 + 1.8 * P}" width="${canW}" height="${h - 3.6 * P}" rx="3" fill="#B9BEC5" stroke="#8E949C"/>`);
        parts.push(txt(canX + canW / 2, cy, p.short, '#3B4048', 11.5, 700));
        const usbX = left ? x1 - 4 : x0 - 10;
        parts.push(`<rect x="${usbX}" y="${cy - 26}" width="14" height="18" rx="2" fill="#C2C6CC" stroke="#7E848C" stroke-width="0.7"/>`);
        parts.push(`<rect x="${usbX}" y="${cy + 8}" width="14" height="18" rx="2" fill="#C2C6CC" stroke="#7E848C" stroke-width="0.7"/>`);
        const tx = left ? (canX + canW + x1) / 2 : (x0 + canX) / 2;
        parts.push(txt(tx, cy - 8, p.id, '#E8ECF2', 14, 700));
        parts.push(txt(tx, cy + 11, `power: ${p.props.power}`, '#A9B1BD', 9.5, 500));
        for (const pin of p.pins) {
          const q = holeXY.get(pin.hole), dy = q.y < cy ? 1 : -1;
          parts.push(txt(q.x, q.y + dy * 11, pin.label, pin.role === 'nc' ? '#6B7280' : '#D5DBE3', 6.5, 600));
        }
      } else if (p.kind === 'single-header') {
        const fill = p.short === 'OLED' ? '#1C2E4A' : p.short === 'GPS' ? '#1E5B53' : '#4E2A80';
        parts.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="4" fill="${fill}" stroke="rgba(0,0,0,.45)"/>`);
        const q0 = holeXY.get(p.pins[0].hole), up = q0.y > cy;
        parts.push(txt(cx, up ? y0 + 10 : y1 - 10, `${p.id} ${p.short}`, '#EEF0FA', 9, 700));
        for (const pin of p.pins) {
          const q = holeXY.get(pin.hole);
          parts.push(txt(q.x, up ? y1 - 8 : y0 + 8, pin.label, '#EEF0FA', 6.3, 600));
        }
      } else if (p.kind === 'rail-module') {
        parts.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="6" fill="#22334F" fill-opacity=".93" stroke="#111B2B"/>`);
        parts.push(`<rect x="${cx - 12}" y="${cy - 30}" width="24" height="16" rx="3" fill="#2B2B2B"/>`);
        parts.push(`<circle cx="${cx}" cy="${cy + 6}" r="7" fill="#C2C6CC"/>`);
        parts.push(txt(cx, y0 + 50, p.id, '#DCE4F2', 11.5, 700));
        parts.push(txt(cx, y0 + 80, `top ${p.props.top}`, '#FFB4A8', 8.5, 600));
        parts.push(txt(cx, y1 - 70, `bottom ${p.props.bottom}`, '#FFB4A8', 8.5, 600));
        parts.push(txt(cx, cy + 24, 'PSU', '#A9B6CC', 8.5, 600));
      } else if (p.kind === 'tactile') {
        parts.push(`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="3" fill="#2E2F33" stroke="#111214" stroke-width="0.8"/>`);
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${(Math.min(w, h) * 0.28).toFixed(1)}" fill="#151618" stroke="#4A4C52" stroke-width="1"/>`);
        parts.push(txt(cx, y1 + 9, p.id, C.label, 8.5, 700));
      }
    }
    if (p.kind === 'two-lead') {
      const A = holeXY.get(p.pins[0].hole), B = holeXY.get(p.pins[1].hole);
      if (!A || !B) continue;
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      const ang = (Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI;
      parts.push(`<line x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}" stroke="#9BA0A6" stroke-width="2.2" stroke-linecap="round"/>`);
      parts.push(`<circle cx="${A.x}" cy="${A.y}" r="2.2" fill="#B5B8BC"/><circle cx="${B.x}" cy="${B.y}" r="2.2" fill="#B5B8BC"/>`);
      parts.push(`<g transform="translate(${mx.toFixed(1)} ${my.toFixed(1)}) rotate(${ang.toFixed(1)})">`);
      if (p.type === 'led') {
        parts.push(`<circle r="7.5" fill="${LED_FILL[p.props.color] || '#D8322B'}" stroke="rgba(0,0,0,.4)" stroke-width="1"/>`);
        parts.push(`<line x1="5.6" y1="-4.6" x2="5.6" y2="4.6" stroke="rgba(0,0,0,.55)" stroke-width="1.6"/>`);
        parts.push(`<ellipse cx="-2.3" cy="-2.8" rx="2.3" ry="1.4" fill="#FFFFFF" opacity=".55"/>`);
      } else {
        const bands = resistorBands(p.props.ohms);
        parts.push(`<rect x="-13" y="-5" width="26" height="10" rx="4.5" fill="#D8C398" stroke="rgba(0,0,0,.35)" stroke-width="0.8"/>`);
        parts.push(`<rect x="-9" y="-4.6" width="2.5" height="9.2" fill="${bands[0]}"/>`);
        parts.push(`<rect x="-4.5" y="-4.6" width="2.5" height="9.2" fill="${bands[1]}"/>`);
        parts.push(`<rect x="0" y="-4.6" width="2.5" height="9.2" fill="${bands[2]}"/>`);
        parts.push(`<rect x="6.5" y="-4.6" width="2.2" height="9.2" fill="${bands[3]}"/>`);
      }
      parts.push(`</g>`);
    }
  }

  // Wires
  const lanes = tidy ? planLanes(state.wires, holeXY) : new Map();
  const wireMidBadges = [];
  for (const w of state.wires) {
    const A = holeXY.get(w.from), B = holeXY.get(w.to);
    if (!A || !B) continue;
    const { d, mid } = wireGeometry(A, B, w.id, tidy, lanes);
    const c = WIRE_HEX[w.color] || WIRE_HEX.green;
    const outlineColor = C.halo ? 'rgba(255,255,255,.85)' : (w.color === 'white' ? 'rgba(0,0,0,.48)' : 'rgba(0,0,0,.28)');
    const outlineWidth = C.halo ? 7 : (w.color === 'white' ? 6.2 : 5.8);
    const shadowXform = C.halo ? '' : ' transform="translate(0.7 1.3)"';
    parts.push(`<path d="${d}" stroke="${outlineColor}" stroke-width="${outlineWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round"${shadowXform}/>`);
    parts.push(`<path d="${d}" stroke="${c}" stroke-width="3.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
    parts.push(`<circle cx="${A.x}" cy="${A.y}" r="2.1" fill="#B5B8BC"/><circle cx="${B.x}" cy="${B.y}" r="2.1" fill="#B5B8BC"/>`);
    if (showWireIds) wireMidBadges.push({ id: w.id, x: mid.x, y: mid.y });
  }

  // Header pins (drawn above wires, matching viewer)
  for (const p of state.parts) {
    if (p.kind === 'two-lead') continue;
    for (const pin of p.pins) {
      const q = holeXY.get(pin.hole);
      if (!q) continue;
      parts.push(`<rect x="${q.x - 3.5}" y="${q.y - 3.5}" width="7" height="7" rx="1.2" fill="${pin.role === 'nc' ? '#7A7468' : '#D4A84A'}" stroke="#8C6A22" stroke-width="0.8"/>`);
    }
  }

  // Two-lead labels (drawn above wires so they remain crisp and legible)
  if (showLabels) {
    for (const p of state.parts) {
      if (p.kind !== 'two-lead') continue;
      const A = holeXY.get(p.pins[0].hole), B = holeXY.get(p.pins[1].hole);
      if (!A || !B) continue;
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      const text = p.type === 'resistor' ? `${p.id} ${formatOhms(p.props.ohms)}` : p.id;
      const ly = my - 13;
      const bw = Math.max(20, text.length * 5.2 + 8);
      parts.push(`<rect x="${(mx - bw / 2).toFixed(1)}" y="${(ly - 6.5).toFixed(1)}" width="${bw.toFixed(1)}" height="13" rx="4" fill="${C.halo ? 'rgba(20,25,27,.88)' : 'rgba(255,255,255,.88)'}" stroke="${C.edge}" stroke-width="0.7"/>`);
      parts.push(txt(mx, ly, text, C.halo ? '#E8ECEA' : '#1E2A2B', 7.8, 700));
    }
  }

  // Optional wire ID badges
  for (const b of wireMidBadges) {
    const bw = Math.max(18, b.id.length * 5.2 + 6);
    parts.push(`<rect x="${(b.x - bw / 2).toFixed(1)}" y="${(b.y - 6).toFixed(1)}" width="${bw.toFixed(1)}" height="12" rx="3" fill="#1B2829" fill-opacity=".86" stroke="#FFFFFF" stroke-width="0.6"/>`);
    parts.push(txt(b.x, b.y, b.id, '#FFFFFF', 7.3, 700));
  }

  // Check highlights on holes
  if (showChecks && flaggedChecks.length) {
    const seenRing = new Set();
    for (const c of flaggedChecks) {
      const color = c.level === 'error' ? '#D3352B' : '#D99A16';
      for (const h of c.holes || []) {
        const key = `${c.level}:${h}`;
        if (seenRing.has(key)) continue;
        seenRing.add(key);
        const q = holeXY.get(h);
        if (!q) continue;
        parts.push(`<rect x="${q.x - 6.5}" y="${q.y - 6.5}" width="13" height="13" rx="3" fill="${color}" fill-opacity=".18" stroke="${color}" stroke-width="2"/>`);
      }
    }
  }

  // Check footer strip when errors/warnings exist
  if (shownChecks.length) {
    const fy = boardBottomY + PAD_BOTTOM;
    parts.push(`<rect x="10" y="${fy}" width="${W - 20}" height="${footerH - 8}" rx="8" fill="${C.halo ? '#141B1C' : '#E6ECEA'}" stroke="${C.halo ? '#2C3B3D' : '#C2CDCA'}" stroke-width="1"/>`);
    shownChecks.forEach((c, idx) => {
      const ry = fy + 14 + idx * FOOTER_ROW_H;
      const badgeColor = c.level === 'error' ? '#B3261E' : '#9A6200';
      const label = c.level.toUpperCase();
      parts.push(`<rect x="18" y="${ry - 6}" width="54" height="12" rx="6" fill="${badgeColor}"/>`);
      parts.push(txt(45, ry, label, '#FFFFFF', 7.2, 700));
      const maxChars = Math.max(55, Math.floor((W - 105) / 5.5));
      const msg = `[${c.code}] ${c.message}`;
      const clipped = msg.length > maxChars ? `${msg.slice(0, maxChars - 1)}…` : msg;
      parts.push(txt(80, ry, clipped, C.ink, 9, 500, 'start'));
    });
    if (overflowChecks > 0) {
      const ry = fy + 14 + shownChecks.length * FOOTER_ROW_H;
      parts.push(txt(18, ry, `… and ${overflowChecks} more error/warning check${overflowChecks === 1 ? '' : 's'} (call check_design for the full list).`, C.inkSoft, 8.8, 600, 'start'));
    }
  }

  parts.push('</svg>');
  return { svg: parts.join('\n'), width: W, height: H, metrics, summary: state.summary };
}

export function renderPng(design, options = {}) {
  const scale = Math.min(3, Math.max(0.5, Number(options.scale ?? 1.5) || 1.5));
  const rendered = renderSvg(design, options);
  const targetWidth = Math.round(rendered.width * scale);
  const resvg = new Resvg(rendered.svg, {
    fitTo: { mode: 'width', value: targetWidth },
    font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
  });
  const pngData = resvg.render();
  const buffer = Buffer.from(pngData.asPng());
  return {
    buffer,
    width: pngData.width,
    height: pngData.height,
    svgWidth: rendered.width,
    svgHeight: rendered.height,
    metrics: rendered.metrics,
    summary: rendered.summary,
  };
}
