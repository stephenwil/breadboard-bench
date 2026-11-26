// Picture cart codec for Breadboard Bench (.bb.png and .bb.json).
// Pure ES module using only Web/Standard APIs (Uint8Array, DataView, TextEncoder/TextDecoder)
// so the exact same module runs in both Node.js and the browser.

export const PNG_CART_KEYWORD = 'breadboard-bench';

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

// Standard IEEE 802.3 CRC-32 table for PNG chunks.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPngBytes(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}

function makeChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length), false);
  return out;
}

function makeItxtChunk(keyword, text) {
  const kw = enc.encode(keyword);
  const payload = enc.encode(text);
  // iTXt format: keyword\0 + compressionFlag(0) + compressionMethod(0) + langTag\0 + translatedKw\0 + utf8 text
  const data = new Uint8Array(kw.length + 5 + payload.length);
  data.set(kw, 0);
  // bytes kw.length .. kw.length+4 are all 0x00
  data.set(payload, kw.length + 5);
  return makeChunk('iTXt', data);
}

function readChunkType(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function parseItxtPayload(data) {
  const nul1 = data.indexOf(0);
  if (nul1 < 0) return null;
  const keyword = dec.decode(data.subarray(0, nul1));
  if (keyword !== PNG_CART_KEYWORD) return null;
  const compFlag = data[nul1 + 1];
  if (compFlag !== 0) return null; // only uncompressed iTXt is written
  const nul2 = data.indexOf(0, nul1 + 3); // end of language tag
  if (nul2 < 0) return null;
  const nul3 = data.indexOf(0, nul2 + 1); // end of translated keyword
  if (nul3 < 0) return null;
  return dec.decode(data.subarray(nul3 + 1));
}

function parseTextPayload(data) {
  const nul = data.indexOf(0);
  if (nul < 0) return null;
  const keyword = dec.decode(data.subarray(0, nul));
  if (keyword !== PNG_CART_KEYWORD) return null;
  return dec.decode(data.subarray(nul + 1));
}

// Embeds a design JSON object into a PNG image as an uncompressed UTF-8 iTXt chunk
// right before IEND. Replaces any existing breadboard-bench metadata chunk.
export function encodePngCart(pngBytes, design) {
  const src = pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes);
  if (!isPngBytes(src)) throw new Error('Not a valid PNG image.');
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const parts = [src.subarray(0, 8)];
  const cartChunk = makeItxtChunk(PNG_CART_KEYWORD, JSON.stringify(design));
  let inserted = false;
  let off = 8;

  while (off + 12 <= src.length) {
    const len = dv.getUint32(off, false);
    const total = 12 + len;
    if (off + total > src.length) throw new Error('Truncated PNG chunk.');
    const type = readChunkType(src, off + 4);
    const data = src.subarray(off + 8, off + 8 + len);

    // Strip any prior cart chunk so re-encoding stays clean.
    const isOldCart =
      (type === 'iTXt' && parseItxtPayload(data) !== null) ||
      (type === 'tEXt' && parseTextPayload(data) !== null);

    if (type === 'IEND' && !inserted) {
      parts.push(cartChunk);
      inserted = true;
    }
    if (!isOldCart) parts.push(src.subarray(off, off + total));
    off += total;
    if (type === 'IEND') break;
  }

  if (!inserted) parts.push(cartChunk);
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

// Extracts an embedded Breadboard Bench design object from a PNG picture cart, or returns null.
export function decodePngCart(pngBytes) {
  const src = pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes);
  if (!isPngBytes(src)) return null;
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  let off = 8;

  while (off + 12 <= src.length) {
    const len = dv.getUint32(off, false);
    const total = 12 + len;
    if (off + total > src.length) break;
    const type = readChunkType(src, off + 4);
    const data = src.subarray(off + 8, off + 8 + len);

    if (type === 'iTXt') {
      const text = parseItxtPayload(data);
      if (text !== null) return JSON.parse(text);
    } else if (type === 'tEXt') {
      const text = parseTextPayload(data);
      if (text !== null) return JSON.parse(text);
    }
    off += total;
    if (type === 'IEND') break;
  }
  return null;
}

// Parses either a .bb.png / .png picture cart or a .bb.json / .json design file from raw bytes.
export function parseCartBytes(bytes) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (isPngBytes(src)) {
    const design = decodePngCart(src);
    if (!design) throw new Error('This PNG image does not contain an embedded Breadboard Bench design.');
    return design;
  }
  try {
    return JSON.parse(dec.decode(src));
  } catch {
    throw new Error('Could not read design JSON. Drop a .json, .bb.json, or .bb.png Breadboard Bench file.');
  }
}
