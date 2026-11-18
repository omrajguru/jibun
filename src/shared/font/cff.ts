/** Minimal, spec-conformant CFF (version 1) writer with Type 2 charstrings. */
import { Writer, concat } from './binary';
import type { Outline, BBox } from './path';

export interface CFFInput {
  fontName: string;
  familyName: string;
  fullName: string;
  version: string;
  glyphNames: string[];
  outlines: Outline[];
  advances: number[];
  fontBBox: BBox;
  unitsPerEm: number;
}

const N_STD_STRINGS = 391;

function index(items: Uint8Array[]): Uint8Array {
  if (items.length === 0) return new Uint8Array([0, 0]);
  let total = 1;
  for (const it of items) total += it.length;
  const offSize = total <= 0xff ? 1 : total <= 0xffff ? 2 : total <= 0xffffff ? 3 : 4;
  const w = new Writer(3 + (items.length + 1) * offSize + total);
  w.u16(items.length).u8(offSize);
  let off = 1;
  const putOff = (v: number) => {
    if (offSize === 1) w.u8(v);
    else if (offSize === 2) w.u16(v);
    else if (offSize === 3) w.u24(v);
    else w.u32(v);
  };
  putOff(off);
  for (const it of items) {
    off += it.length;
    putOff(off);
  }
  for (const it of items) w.bytes(it);
  return w.toBytes();
}

function dictInt(w: Writer, v: number) {
  if (!Number.isInteger(v)) return dictReal(w, v);
  if (v >= -107 && v <= 107) w.u8(v + 139);
  else if (v >= 108 && v <= 1131) {
    const x = v - 108;
    w.u8((x >> 8) + 247).u8(x & 0xff);
  } else if (v >= -1131 && v <= -108) {
    const x = -v - 108;
    w.u8((x >> 8) + 251).u8(x & 0xff);
  } else if (v >= -32768 && v <= 32767) w.u8(28).i16(v);
  else w.u8(29).i32(v);
}

function dictInt32(w: Writer, v: number) {
  w.u8(29).i32(v);
}

function dictReal(w: Writer, v: number) {
  const s = Number(v.toPrecision(10)).toString().replace('e+', 'E').replace('e-', 'E-').replace('e', 'E');
  const nibbles: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch >= '0' && ch <= '9') nibbles.push(ch.charCodeAt(0) - 48);
    else if (ch === '.') nibbles.push(0xa);
    else if (ch === 'E') {
      if (s[i + 1] === '-') {
        nibbles.push(0xc);
        i++;
      } else nibbles.push(0xb);
    } else if (ch === '-') nibbles.push(0xe);
  }
  nibbles.push(0xf);
  if (nibbles.length % 2) nibbles.push(0xf);
  w.u8(30);
  for (let i = 0; i < nibbles.length; i += 2) w.u8((nibbles[i]! << 4) | nibbles[i + 1]!);
}

function op(w: Writer, code: number) {
  if (code >= 1200) w.u8(12).u8(code - 1200);
  else w.u8(code);
}

function csNum(w: Writer, v: number) {
  if (v >= -107 && v <= 107) w.u8(v + 139);
  else if (v >= 108 && v <= 1131) {
    const x = v - 108;
    w.u8((x >> 8) + 247).u8(x & 0xff);
  } else if (v >= -1131 && v <= -108) {
    const x = -v - 108;
    w.u8((x >> 8) + 251).u8(x & 0xff);
  } else if (v >= -32768 && v <= 32767) w.u8(28).i16(v);
  else throw new RangeError(`charstring operand ${v} out of range`);
}

function charstring(o: Outline, width: number): Uint8Array {
  const w = new Writer(64);
  let cx = 0;
  let cy = 0;
  let first = true;
  const R = Math.round;
  for (const c of o) {
    const sx = R(c.start.x);
    const sy = R(c.start.y);
    if (first) csNum(w, width);
    csNum(w, sx - cx);
    csNum(w, sy - cy);
    op(w, 21); // rmoveto
    first = false;
    cx = sx;
    cy = sy;
    for (const s of c.segs) {
      if (s.t === 'L') {
        const x = R(s.p.x);
        const y = R(s.p.y);
        csNum(w, x - cx);
        csNum(w, y - cy);
        op(w, 5);
        cx = x;
        cy = y;
      } else {
        const x1 = R(s.c1.x);
        const y1 = R(s.c1.y);
        const x2 = R(s.c2.x);
        const y2 = R(s.c2.y);
        const x = R(s.p.x);
        const y = R(s.p.y);
        csNum(w, x1 - cx);
        csNum(w, y1 - cy);
        csNum(w, x2 - x1);
        csNum(w, y2 - y1);
        csNum(w, x - x2);
        csNum(w, y - y2);
        op(w, 8);
        cx = x;
        cy = y;
      }
    }
  }
  if (first) csNum(w, width);
  op(w, 14); // endchar
  return w.toBytes();
}

const latin1 = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 128 ? c : 0x3f;
  }
  return out;
};

export function buildCFF(input: CFFInput): Uint8Array {
  const n = input.glyphNames.length;
  const strings: string[] = [input.version, input.fullName, input.familyName];
  const sidVersion = N_STD_STRINGS;
  const sidFull = N_STD_STRINGS + 1;
  const sidFamily = N_STD_STRINGS + 2;
  const firstGlyphSid = N_STD_STRINGS + strings.length;
  for (let i = 1; i < n; i++) strings.push(input.glyphNames[i]!);
  if (firstGlyphSid + n - 2 > 64999) throw new Error('too many glyph names for CFF');

  const header = new Uint8Array([1, 0, 4, 4]);
  const nameIndex = index([latin1(input.fontName)]);
  const stringIndex = index(strings.map(latin1));
  const gsubrIndex = index([]);

  // charset format 2: one range of consecutive SIDs
  const cs = new Writer(8);
  cs.u8(2);
  if (n > 1) cs.u16(firstGlyphSid).u16(n - 2);
  const charset = cs.toBytes();

  const charStrings = index(input.outlines.map((o, i) => charstring(o, input.advances[i]!)));

  const priv = new Writer(16);
  dictInt(priv, 0);
  op(priv, 20); // defaultWidthX
  dictInt(priv, 0);
  op(priv, 21); // nominalWidthX
  const privateDict = priv.toBytes();

  const topDict = (charsetOff: number, csOff: number, privOff: number) => {
    const t = new Writer(64);
    dictInt(t, sidVersion);
    op(t, 0);
    dictInt(t, sidFull);
    op(t, 2);
    dictInt(t, sidFamily);
    op(t, 3);
    if (input.unitsPerEm !== 1000) {
      const s = 1 / input.unitsPerEm;
      for (const v of [s, 0, 0, s, 0, 0]) dictReal(t, v);
      op(t, 1207);
    }
    const b = input.fontBBox;
    for (const v of [b.xMin, b.yMin, b.xMax, b.yMax]) dictInt(t, Math.round(v));
    op(t, 5);
    dictInt32(t, charsetOff);
    op(t, 15);
    dictInt32(t, csOff);
    op(t, 17);
    dictInt32(t, privateDict.length);
    dictInt32(t, privOff);
    op(t, 18);
    return t.toBytes();
  };
  const probe = index([topDict(0, 0, 0)]);
  const base = header.length + nameIndex.length + probe.length + stringIndex.length + gsubrIndex.length;
  const charsetOff = base;
  const csOff = charsetOff + charset.length;
  const privOff = csOff + charStrings.length;
  const topIndex = index([topDict(charsetOff, csOff, privOff)]);
  if (topIndex.length !== probe.length) throw new Error('CFF top dict size changed');
  return concat([header, nameIndex, topIndex, stringIndex, gsubrIndex, charset, charStrings, privateDict]);
}
