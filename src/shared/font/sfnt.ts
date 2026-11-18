/**
 * SFNT compiler: turns a fully resolved FontSpec into TrueType (glyf) or
 * OpenType/CFF bytes. Pure TypeScript, runs in browsers, Workers and Node.
 */
import { Writer, concat, tableChecksum } from './binary';
import { buildCFF } from './cff';
import { buildGDEF, buildLayoutTable, type FeatureDef, type LookupDef } from './otl';
import { contourToQuadPoints, normaliseWinding, outlineBBox, isEmptyBBox, type Outline, type BBox } from './path';

export interface GlyphSpec {
  name: string;
  unicodes: number[];
  advance: number;
  outline: Outline;
  /** GDEF class: 1 base, 2 ligature, 3 mark, 4 component */
  gdefClass?: 1 | 2 | 3;
}

export interface FontSpec {
  familyName: string;
  styleName: string;
  version: string; // e.g. "1.000"
  unitsPerEm: number;
  ascender: number;
  descender: number; // negative
  lineGap: number;
  xHeight: number;
  capHeight: number;
  glyphs: GlyphSpec[]; // glyph 0 must be .notdef
  gsub?: { scripts: string[]; features: FeatureDef[]; lookups: LookupDef[] };
  gpos?: { scripts: string[]; features: FeatureDef[]; lookups: LookupDef[] };
  created?: Date;
  unicodeRanges?: [number, number, number, number];
  maxContext?: number;
}

export type OutlineFormat = 'ttf' | 'otf';

interface Table {
  tag: string;
  data: Uint8Array;
}

export function compileFont(spec: FontSpec, format: OutlineFormat): Uint8Array {
  validateSpec(spec, format);
  const created = spec.created ?? new Date();
  const roundedOutlines = spec.glyphs.map((g) => normaliseWinding(g.outline, format === 'ttf' ? 'cw' : 'ccw'));
  let glyfInfo: ReturnType<typeof buildGlyf> | null = null;
  if (format === 'ttf') glyfInfo = buildGlyf(roundedOutlines);
  const bboxes = glyfInfo ? glyfInfo.bboxes : roundedOutlines.map((o) => roundBBox(outlineBBox(o)));
  const advances = spec.glyphs.map((g) => Math.max(0, Math.round(g.advance)));

  const fontBBox = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  let first = true;
  for (const b of bboxes) {
    if (isEmptyBBox(b)) continue;
    if (first) {
      Object.assign(fontBBox, b);
      first = false;
    } else {
      fontBBox.xMin = Math.min(fontBBox.xMin, b.xMin);
      fontBBox.yMin = Math.min(fontBBox.yMin, b.yMin);
      fontBBox.xMax = Math.max(fontBBox.xMax, b.xMax);
      fontBBox.yMax = Math.max(fontBBox.yMax, b.yMax);
    }
  }

  const tables: Table[] = [];
  if (glyfInfo) {
    tables.push({ tag: 'glyf', data: glyfInfo.glyf }, { tag: 'loca', data: glyfInfo.loca });
  } else {
    tables.push({
      tag: 'CFF ',
      data: buildCFF({
        fontName: postScriptName(spec),
        familyName: spec.familyName,
        fullName: `${spec.familyName} ${spec.styleName}`,
        version: spec.version,
        glyphNames: spec.glyphs.map((g) => g.name),
        outlines: roundedOutlines,
        advances,
        fontBBox,
        unitsPerEm: spec.unitsPerEm,
      }),
    });
  }

  tables.push({ tag: 'head', data: buildHead(spec, fontBBox, created, glyfInfo?.longLoca ?? false) });
  tables.push({ tag: 'hhea', data: buildHhea(spec, advances, bboxes, fontBBox) });
  tables.push({ tag: 'hmtx', data: buildHmtx(advances, bboxes) });
  tables.push({ tag: 'maxp', data: buildMaxp(spec.glyphs.length, format, glyfInfo, spec.maxContext ?? 1) });
  tables.push({ tag: 'OS/2', data: buildOS2(spec, advances, fontBBox) });
  tables.push({ tag: 'name', data: buildName(spec) });
  tables.push({ tag: 'cmap', data: buildCmap(spec.glyphs) });
  tables.push({ tag: 'post', data: buildPost() });
  const classes = new Map<number, number>();
  spec.glyphs.forEach((g, i) => g.gdefClass && classes.set(i, g.gdefClass));
  if (classes.size) tables.push({ tag: 'GDEF', data: buildGDEF(classes) });
  if (spec.gsub && spec.gsub.lookups.length) tables.push({ tag: 'GSUB', data: buildLayoutTable('GSUB', spec.gsub.scripts, spec.gsub.features, spec.gsub.lookups) });
  if (spec.gpos && spec.gpos.lookups.length) tables.push({ tag: 'GPOS', data: buildLayoutTable('GPOS', spec.gpos.scripts, spec.gpos.features, spec.gpos.lookups) });

  return assemble(tables, format === 'ttf' ? 0x00010000 : 0x4f54544f);
}

function validateSpec(spec: FontSpec, format: OutlineFormat) {
  if (!spec.glyphs.length || spec.glyphs[0]!.name !== '.notdef') throw new Error('glyph 0 must be .notdef');
  const limit = format === 'otf' ? 64000 : 65535;
  if (spec.glyphs.length > limit) throw new Error(`too many glyphs for ${format.toUpperCase()}: ${spec.glyphs.length} > ${limit}`);
  const names = new Set<string>();
  for (const g of spec.glyphs) {
    if (names.has(g.name)) throw new Error(`duplicate glyph name ${g.name}`);
    names.add(g.name);
  }
  const cps = new Set<number>();
  for (const g of spec.glyphs)
    for (const u of g.unicodes) {
      if (cps.has(u)) throw new Error(`codepoint U+${u.toString(16)} mapped twice`);
      cps.add(u);
    }
}

function roundBBox(b: BBox): BBox {
  if (isEmptyBBox(b)) return b;
  return { xMin: Math.floor(b.xMin), yMin: Math.floor(b.yMin), xMax: Math.ceil(b.xMax), yMax: Math.ceil(b.yMax) };
}

export function postScriptName(spec: FontSpec): string {
  const clean = (s: string) => s.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '');
  const fam = clean(spec.familyName) || 'Jibun';
  const sty = clean(spec.styleName) || 'Regular';
  return `${fam}-${sty}`.slice(0, 63);
}

// ------------------------------------------------------------------ assembly

function assemble(tablesIn: Table[], sfntVersion: number): Uint8Array {
  const tables = tablesIn.slice().sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = tables.length;
  let p2 = 1;
  let log2 = 0;
  while (p2 * 2 <= numTables) {
    p2 *= 2;
    log2++;
  }
  const searchRange = p2 * 16;
  const head = new Writer(12 + 16 * numTables);
  head.u32(sfntVersion).u16(numTables).u16(searchRange).u16(log2).u16(numTables * 16 - searchRange);
  let offset = 12 + 16 * numTables;
  const bodies: Uint8Array[] = [];
  let headOffset = -1;
  for (const t of tables) {
    const data = t.tag === 'head' ? zeroCheckSumAdjustment(t.data) : t.data;
    head.tag(t.tag).u32(tableChecksum(data)).u32(offset).u32(data.length);
    if (t.tag === 'head') headOffset = offset;
    const padded = new Uint8Array((data.length + 3) & ~3);
    padded.set(data);
    bodies.push(padded);
    offset += padded.length;
  }
  const font = concat([head.toBytes(), ...bodies]);
  if (headOffset >= 0) {
    const adj = (0xb1b0afba - tableChecksum(font)) >>> 0;
    new DataView(font.buffer, font.byteOffset).setUint32(headOffset + 8, adj);
  }
  return font;
}

function zeroCheckSumAdjustment(head: Uint8Array): Uint8Array {
  const c = head.slice();
  c[8] = c[9] = c[10] = c[11] = 0;
  return c;
}

// ------------------------------------------------------------------ tables

function buildHead(spec: FontSpec, bbox: BBox, created: Date, longLoca: boolean): Uint8Array {
  const w = new Writer(54);
  const [maj, min] = spec.version.split('.').map((x) => parseInt(x, 10) || 0);
  w.u16(1).u16(0); // version
  w.fixed((maj ?? 1) + (min ?? 0) / 1000); // fontRevision
  w.u32(0); // checkSumAdjustment (patched)
  w.u32(0x5f0f3cf5);
  w.u16(0b0000_0000_0000_1011); // flags: baseline at y=0, lsb at x=0 (bit1), integer ppem (bit3)
  w.u16(spec.unitsPerEm);
  w.longDateTime(created).longDateTime(created);
  w.i16(bbox.xMin).i16(bbox.yMin).i16(bbox.xMax).i16(bbox.yMax);
  w.u16(0); // macStyle
  w.u16(8); // lowestRecPPEM
  w.i16(2); // fontDirectionHint
  w.i16(longLoca ? 1 : 0);
  w.i16(0);
  return w.toBytes();
}

function buildHhea(spec: FontSpec, adv: number[], bboxes: BBox[], fontBBox: BBox): Uint8Array {
  let minL = 0;
  let minR = 0;
  let maxExt = 0;
  let firstInk = true;
  bboxes.forEach((b, i) => {
    if (isEmptyBBox(b)) return;
    const lsb = b.xMin;
    const rsb = adv[i]! - b.xMax;
    const ext = b.xMax;
    if (firstInk) {
      minL = lsb;
      minR = rsb;
      maxExt = ext;
      firstInk = false;
    } else {
      minL = Math.min(minL, lsb);
      minR = Math.min(minR, rsb);
      maxExt = Math.max(maxExt, ext);
    }
  });
  const w = new Writer(36);
  w.u16(1).u16(0);
  w.i16(Math.max(spec.ascender, fontBBox.yMax));
  w.i16(Math.min(spec.descender, fontBBox.yMin));
  w.i16(spec.lineGap);
  w.u16(Math.max(0, ...adv));
  w.i16(minL).i16(minR).i16(maxExt);
  w.i16(1).i16(0).i16(0); // caret
  w.zeros(8);
  w.i16(0);
  w.u16(adv.length); // numberOfHMetrics (full)
  return w.toBytes();
}

function buildHmtx(adv: number[], bboxes: BBox[]): Uint8Array {
  const w = new Writer(adv.length * 4);
  adv.forEach((a, i) => {
    const b = bboxes[i]!;
    w.u16(a).i16(isEmptyBBox(b) ? 0 : b.xMin);
  });
  return w.toBytes();
}

function buildMaxp(numGlyphs: number, format: OutlineFormat, glyf: { maxPoints: number; maxContours: number } | null, _maxContext: number): Uint8Array {
  const w = new Writer(32);
  if (format === 'otf') {
    w.u32(0x00005000).u16(numGlyphs);
  } else {
    w.u32(0x00010000).u16(numGlyphs);
    w.u16(glyf!.maxPoints).u16(glyf!.maxContours);
    w.u16(0).u16(0); // composite
    w.u16(2); // maxZones
    w.u16(0).u16(0).u16(0).u16(0).u16(0).u16(0); // twilight, storage, fdefs, idefs, stack, instr size
    w.u16(0).u16(0); // maxComponentElements, maxComponentDepth
  }
  return w.toBytes();
}

function buildOS2(spec: FontSpec, adv: number[], fontBBox: BBox): Uint8Array {
  const inked = adv.filter((a) => a > 0);
  const avg = inked.length ? Math.round(inked.reduce((s, a) => s + a, 0) / inked.length) : 0;
  const cps = spec.glyphs.flatMap((g) => g.unicodes).sort((a, b) => a - b);
  const em = spec.unitsPerEm;
  const ranges = spec.unicodeRanges ?? computeUnicodeRanges(cps);
  const w = new Writer(96);
  w.u16(4);
  w.i16(avg);
  w.u16(400).u16(5);
  w.u16(0); // fsType: installable
  w.i16(Math.round(em * 0.65)).i16(Math.round(em * 0.6)).i16(0).i16(Math.round(em * 0.075)); // subscript
  w.i16(Math.round(em * 0.65)).i16(Math.round(em * 0.6)).i16(0).i16(Math.round(em * 0.35)); // superscript
  w.i16(Math.round(em * 0.05)).i16(Math.round(spec.xHeight * 0.55)); // strikeout
  w.i16(0); // family class
  w.zeros(10); // panose
  for (const r of ranges) w.u32(r >>> 0);
  w.tag('JIBN');
  w.u16(0x0040 | 0x0080); // REGULAR | USE_TYPO_METRICS
  const first = cps.length ? Math.min(cps[0]!, 0xffff) : 0x20;
  const last = cps.length ? Math.min(cps[cps.length - 1]!, 0xffff) : 0x20;
  w.u16(first).u16(last);
  const asc = spec.ascender;
  const desc = spec.descender;
  w.i16(asc).i16(desc).i16(spec.lineGap);
  w.u16(Math.max(0, Math.max(asc, fontBBox.yMax))).u16(Math.max(0, -Math.min(desc, fontBBox.yMin)));
  // code page ranges: Latin 1 (bit 0), plus Cyrillic (2), Greek (3), Vietnamese (8), Japanese (17)
  let cp1 = 1;
  if (cps.some((c) => c >= 0x400 && c <= 0x4ff)) cp1 |= 1 << 2;
  if (cps.some((c) => c >= 0x370 && c <= 0x3ff)) cp1 |= 1 << 3;
  if (cps.some((c) => c >= 0x1ea0 && c <= 0x1ef9)) cp1 |= 1 << 8;
  if (cps.some((c) => c >= 0x3040 && c <= 0x30ff)) cp1 |= 1 << 17;
  w.u32(cp1 >>> 0).u32(0);
  w.i16(spec.xHeight).i16(spec.capHeight);
  w.u16(0).u16(0x20).u16(spec.maxContext ?? 1);
  return w.toBytes();
}

function computeUnicodeRanges(cps: number[]): [number, number, number, number] {
  const r: [number, number, number, number] = [0, 0, 0, 0];
  const set = (bit: number) => (r[bit >> 5] = (r[bit >> 5]! | (1 << (bit & 31))) >>> 0);
  const blocks: [number, number, number][] = [
    [0x0000, 0x007f, 0],
    [0x0080, 0x00ff, 1],
    [0x0100, 0x017f, 2],
    [0x0180, 0x024f, 3],
    [0x0300, 0x036f, 6],
    [0x0370, 0x03ff, 7],
    [0x0400, 0x04ff, 9],
    [0x0900, 0x097f, 15],
    [0x1e00, 0x1eff, 29],
    [0x2000, 0x206f, 31],
    [0x20a0, 0x20cf, 33],
    [0x2100, 0x214f, 35],
    [0x2190, 0x21ff, 37],
    [0x2200, 0x22ff, 38],
    [0x3040, 0x309f, 49],
    [0x30a0, 0x30ff, 50],
  ];
  for (const c of cps) for (const [s, e, bit] of blocks) if (c >= s && c <= e) set(bit);
  if (cps.some((c) => c > 0xffff)) set(57);
  return r;
}

function utf16be(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c >> 8;
    out[i * 2 + 1] = c & 0xff;
  }
  return out;
}

function buildName(spec: FontSpec): Uint8Array {
  const ps = postScriptName(spec);
  const full = `${spec.familyName} ${spec.styleName}`;
  const recs: [number, string][] = [
    [0, 'Made with Jibun'],
    [1, spec.familyName],
    [2, spec.styleName],
    [3, `${spec.version};JIBN;${ps}`],
    [4, full],
    [5, `Version ${spec.version}`],
    [6, ps],
  ];
  const strings = recs.map(([, s]) => utf16be(s));
  const w = new Writer(256);
  w.u16(0).u16(recs.length).u16(6 + recs.length * 12);
  let off = 0;
  recs.forEach(([id], i) => {
    w.u16(3).u16(1).u16(0x0409).u16(id).u16(strings[i]!.length).u16(off);
    off += strings[i]!.length;
  });
  for (const s of strings) w.bytes(s);
  return w.toBytes();
}

function buildCmap(glyphs: GlyphSpec[]): Uint8Array {
  const map = new Map<number, number>();
  glyphs.forEach((g, gid) => g.unicodes.forEach((u) => map.set(u, gid)));
  const all = [...map.keys()].sort((a, b) => a - b);
  const bmp = all.filter((c) => c <= 0xffff);
  const hasSupp = all.some((c) => c > 0xffff);

  // Format 4
  const segs: { start: number; end: number; gids: number[] }[] = [];
  for (const c of bmp) {
    if (c === 0xffff) continue;
    const last = segs[segs.length - 1];
    if (last && last.end + 1 === c) {
      last.end = c;
      last.gids.push(map.get(c)!);
    } else segs.push({ start: c, end: c, gids: [map.get(c)!] });
  }
  segs.push({ start: 0xffff, end: 0xffff, gids: [0] });
  const segX2 = segs.length * 2;
  let p2 = 1;
  let log2 = 0;
  while (p2 * 2 <= segs.length) {
    p2 *= 2;
    log2++;
  }
  // Decide per segment: idDelta when gids consecutive, else idRangeOffset into glyphIdArray.
  const useDelta = segs.map((s) => s.gids.every((g, i) => g - s.gids[0]! === i));
  const glyphIdArray: number[] = [];
  const rangeOffsets: number[] = [];
  segs.forEach((s, i) => {
    if (useDelta[i]) rangeOffsets.push(0);
    else {
      // offset in bytes from this idRangeOffset entry to the glyph id
      rangeOffsets.push((segs.length - i) * 2 + glyphIdArray.length * 2);
      glyphIdArray.push(...s.gids);
    }
  });
  const f4 = new Writer(16 + segs.length * 8 + glyphIdArray.length * 2);
  const f4len = 16 + segs.length * 8 + glyphIdArray.length * 2;
  if (f4len > 0xffff) throw new Error('cmap format 4 subtable too large');
  f4.u16(4).u16(f4len).u16(0).u16(segX2).u16(p2 * 2).u16(log2).u16(segX2 - p2 * 2);
  for (const s of segs) f4.u16(s.end);
  f4.u16(0);
  for (const s of segs) f4.u16(s.start);
  segs.forEach((s, i) => f4.u16(useDelta[i] ? (s.gids[0]! - s.start + 0x10000) & 0xffff : 0));
  for (const r of rangeOffsets) f4.u16(r);
  for (const g of glyphIdArray) f4.u16(g);
  const fmt4 = f4.toBytes();

  let fmt12: Uint8Array | null = null;
  if (hasSupp) {
    const groups: { s: number; e: number; g: number }[] = [];
    for (const c of all) {
      const g = map.get(c)!;
      const last = groups[groups.length - 1];
      if (last && last.e + 1 === c && last.g + (c - last.s) === g) last.e = c;
      else groups.push({ s: c, e: c, g });
    }
    const w = new Writer(16 + groups.length * 12);
    w.u16(12).u16(0).u32(16 + groups.length * 12).u32(0).u32(groups.length);
    for (const gr of groups) w.u32(gr.s).u32(gr.e).u32(gr.g);
    fmt12 = w.toBytes();
  }

  const records: [number, number, Uint8Array][] = [
    [0, 3, fmt4],
    [3, 1, fmt4],
  ];
  if (fmt12) records.push([0, 4, fmt12], [3, 10, fmt12]);
  records.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const w = new Writer(256);
  w.u16(0).u16(records.length);
  const placed = new Map<Uint8Array, number>();
  let off = 4 + records.length * 8;
  const bodies: Uint8Array[] = [];
  for (const [pid, eid, data] of records) {
    let at = placed.get(data);
    if (at === undefined) {
      at = off;
      placed.set(data, at);
      bodies.push(data);
      off += data.length;
    }
    w.u16(pid).u16(eid).u32(at);
  }
  for (const b of bodies) w.bytes(b);
  return w.toBytes();
}

function buildPost(): Uint8Array {
  const w = new Writer(32);
  w.u32(0x00030000).fixed(0).i16(-75).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);
  return w.toBytes();
}

// ------------------------------------------------------------------ glyf

function buildGlyf(outlines: Outline[]) {
  const parts: Uint8Array[] = [];
  const bboxes: BBox[] = [];
  const offsets: number[] = [0];
  let total = 0;
  let maxPoints = 0;
  let maxContours = 0;
  outlines.forEach((o, i) => {
    let data: Uint8Array = new Uint8Array(0);
    let bbox: BBox = { xMin: Infinity, yMin: Infinity, xMax: -Infinity, yMax: -Infinity };
    if (o.length) {
      const contours = o.map((c) => contourToQuadPoints(c, 0.5)).filter((pts) => pts.length >= 2);
      if (contours.length) {
        const res = encodeSimpleGlyph(contours);
        data = res.data;
        bbox = res.bbox;
        maxPoints = Math.max(maxPoints, res.points);
        maxContours = Math.max(maxContours, contours.length);
      }
    }
    bboxes.push(bbox);
    void i;
    const padded = new Uint8Array((data.length + 3) & ~3);
    padded.set(data);
    parts.push(padded);
    total += padded.length;
    offsets.push(total);
  });
  const longLoca = total > 0x1fffe;
  const lw = new Writer(offsets.length * (longLoca ? 4 : 2));
  for (const o of offsets) {
    if (longLoca) lw.u32(o);
    else lw.u16(o / 2);
  }
  return { glyf: concat(parts), loca: lw.toBytes(), longLoca, maxPoints, maxContours, bboxes };
}

function encodeSimpleGlyph(contours: { x: number; y: number; on: boolean }[][]) {
  // Round points, compute exact bbox from the rounded points (TrueType bbox must match points).
  const pts = contours.map((c) => c.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), on: p.on })));
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const c of pts)
    for (const p of c) {
      xMin = Math.min(xMin, p.x);
      yMin = Math.min(yMin, p.y);
      xMax = Math.max(xMax, p.x);
      yMax = Math.max(yMax, p.y);
    }
  const w = new Writer(256);
  w.i16(pts.length).i16(xMin).i16(yMin).i16(xMax).i16(yMax);
  let n = 0;
  for (const c of pts) {
    n += c.length;
    w.u16(n - 1);
  }
  w.u16(0); // instructionLength
  const flat = pts.flat();
  const flags: number[] = [];
  const xs = new Writer(flat.length * 2);
  const ys = new Writer(flat.length * 2);
  let px = 0;
  let py = 0;
  for (const p of flat) {
    let f = p.on ? 0x01 : 0;
    const dx = p.x - px;
    const dy = p.y - py;
    if (dx === 0) f |= 0x10;
    else if (Math.abs(dx) < 256) {
      f |= 0x02;
      if (dx > 0) f |= 0x10;
      xs.u8(Math.abs(dx));
    } else xs.i16(dx);
    if (dy === 0) f |= 0x20;
    else if (Math.abs(dy) < 256) {
      f |= 0x04;
      if (dy > 0) f |= 0x20;
      ys.u8(Math.abs(dy));
    } else ys.i16(dy);
    flags.push(f);
    px = p.x;
    py = p.y;
  }
  // Flag run-length compression
  for (let i = 0; i < flags.length; ) {
    const f = flags[i]!;
    let run = 0;
    while (i + 1 + run < flags.length && flags[i + 1 + run] === f && run < 255) run++;
    if (run > 0) {
      w.u8(f | 0x08).u8(run);
      i += run + 1;
    } else {
      w.u8(f);
      i++;
    }
  }
  w.bytes(xs.toBytes()).bytes(ys.toBytes());
  return { data: w.toBytes(), points: flat.length, bbox: { xMin, yMin, xMax, yMax } };
}
