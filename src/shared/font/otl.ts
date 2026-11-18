/**
 * OpenType Layout (GSUB / GPOS / GDEF) builders.
 *
 * Every lookup is wrapped in an Extension subtable (GSUB 7 / GPOS 9) whose 32-bit
 * offset points into a data blob appended after the LookupList. This keeps every
 * 16-bit offset in the table small regardless of how many glyphs the font has.
 * Individual subtables are split by the callers so they stay under 64 KB.
 */
import { Writer, concat, off16 } from './binary';
import type { Pt } from './path';

export function uniqSorted(gids: Iterable<number>): number[] {
  return [...new Set(gids)].sort((a, b) => a - b);
}

export function coverage(gidsIn: Iterable<number>): Uint8Array {
  const gids = uniqSorted(gidsIn);
  const ranges: [number, number][] = [];
  for (const g of gids) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] + 1 === g) last[1] = g;
    else ranges.push([g, g]);
  }
  const w = new Writer(16);
  if (4 + gids.length * 2 <= 4 + ranges.length * 6) {
    w.u16(1).u16(gids.length);
    for (const g of gids) w.u16(g);
  } else {
    w.u16(2).u16(ranges.length);
    let idx = 0;
    for (const [s, e] of ranges) {
      w.u16(s).u16(e).u16(idx);
      idx += e - s + 1;
    }
  }
  return w.toBytes();
}

/** ClassDef format 2. Glyphs not listed are class 0. */
export function classDef(classes: Map<number, number>): Uint8Array {
  const entries = [...classes.entries()].filter(([, c]) => c !== 0).sort((a, b) => a[0] - b[0]);
  const ranges: [number, number, number][] = [];
  for (const [g, c] of entries) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] + 1 === g && last[2] === c) last[1] = g;
    else ranges.push([g, g, c]);
  }
  const w = new Writer(16);
  w.u16(2).u16(ranges.length);
  for (const [s, e, c] of ranges) w.u16(s).u16(e).u16(c);
  return w.toBytes();
}

function anchor(p: Pt): Uint8Array {
  return new Writer(6).u16(1).i16(Math.round(p.x)).i16(Math.round(p.y)).toBytes();
}

/**
 * Lay out a block consisting of a fixed header followed by referenced child blocks,
 * returning the header writer offsets patched in place.
 */
class Block {
  w = new Writer(64);
  private patches: { at: number; child: Uint8Array; base: number; ctx: string }[] = [];
  /** Reserve a 16-bit offset (relative to `base`, default 0 = start of this block) to `child`. */
  offset16(child: Uint8Array, ctx: string, base = 0) {
    this.patches.push({ at: this.w.pos, child, base, ctx });
    this.w.u16(0);
  }
  finish(): Uint8Array {
    const children: Uint8Array[] = [];
    const placed = new Map<Uint8Array, number>();
    let end = this.w.length;
    for (const p of this.patches) {
      let at = placed.get(p.child);
      if (at === undefined) {
        at = end;
        placed.set(p.child, at);
        children.push(p.child);
        end += p.child.length;
      }
      this.w.setU16(p.at, off16(at - p.base, p.ctx));
    }
    return concat([this.w.toBytes(), ...children]);
  }
}

// ------------------------------------------------------------------ GSUB subtables

export function singleSubst(map: Map<number, number>): Uint8Array {
  // Format 2: explicit substitute list.
  const from = uniqSorted(map.keys());
  const b = new Block();
  b.w.u16(2);
  b.offset16(coverage(from), 'SingleSubst coverage');
  b.w.u16(from.length);
  for (const g of from) b.w.u16(map.get(g)!);
  return b.finish();
}

export interface Ligature {
  components: number[]; // full sequence, first included
  glyph: number;
}

/** Split ligatures into one or more LigatureSubst subtables. */
export function ligatureSubstTables(ligs: Ligature[]): Uint8Array[] {
  const byFirst = new Map<number, Ligature[]>();
  for (const l of ligs) {
    if (l.components.length < 2) continue;
    const arr = byFirst.get(l.components[0]!) ?? [];
    // Drop exact duplicates (first definition wins).
    if (!arr.some((x) => x.components.join() === l.components.join())) arr.push(l);
    byFirst.set(l.components[0]!, arr);
  }
  const firsts = uniqSorted(byFirst.keys());
  const out: Uint8Array[] = [];
  const CHUNK = 400;
  for (let i = 0; i < firsts.length; i += CHUNK) {
    const chunk = firsts.slice(i, i + CHUNK);
    const b = new Block();
    b.w.u16(1);
    b.offset16(coverage(chunk), 'LigatureSubst coverage');
    b.w.u16(chunk.length);
    for (const f of chunk) {
      // Longer sequences first so they win.
      const set = byFirst.get(f)!.slice().sort((a, b2) => b2.components.length - a.components.length);
      const sb = new Block();
      sb.w.u16(set.length);
      for (const l of set) {
        const lw = new Writer(8);
        lw.u16(l.glyph).u16(l.components.length);
        for (const c of l.components.slice(1)) lw.u16(c);
        sb.offset16(lw.toBytes(), 'Ligature');
      }
      b.offset16(sb.finish(), 'LigatureSet');
    }
    out.push(b.finish());
  }
  return out;
}

export interface ChainRule {
  backtrack: number[][]; // coverage sets, nearest first
  input: number[][];
  lookahead: number[][];
  lookups: { sequenceIndex: number; lookupIndex: number }[];
}

export function chainContextFormat3(rule: ChainRule): Uint8Array {
  const b = new Block();
  b.w.u16(3);
  b.w.u16(rule.backtrack.length);
  for (const c of rule.backtrack) b.offset16(coverage(c), 'chain backtrack');
  b.w.u16(rule.input.length);
  for (const c of rule.input) b.offset16(coverage(c), 'chain input');
  b.w.u16(rule.lookahead.length);
  for (const c of rule.lookahead) b.offset16(coverage(c), 'chain lookahead');
  b.w.u16(rule.lookups.length);
  for (const l of rule.lookups) b.w.u16(l.sequenceIndex).u16(l.lookupIndex);
  return b.finish();
}

// ------------------------------------------------------------------ GPOS subtables

/** PairPos format 1 with XAdvance on the first glyph, split to stay under 64 KB. */
export function pairPosTables(pairs: Map<number, Map<number, number>>): Uint8Array[] {
  const firsts = uniqSorted(pairs.keys()).filter((f) => pairs.get(f)!.size > 0);
  const out: Uint8Array[] = [];
  let chunk: number[] = [];
  let size = 10;
  const flush = () => {
    if (!chunk.length) return;
    const b = new Block();
    b.w.u16(1);
    b.offset16(coverage(chunk), 'PairPos coverage');
    b.w.u16(0x0004).u16(0x0000).u16(chunk.length);
    for (const f of chunk) {
      const seconds = [...pairs.get(f)!.entries()].sort((a, c) => a[0] - c[0]);
      const pw = new Writer(2 + seconds.length * 4);
      pw.u16(seconds.length);
      for (const [s, v] of seconds) pw.u16(s).i16(v);
      b.offset16(pw.toBytes(), 'PairSet');
    }
    out.push(b.finish());
    chunk = [];
    size = 10;
  };
  for (const f of firsts) {
    const setSize = 2 + pairs.get(f)!.size * 4 + 2 + 4; // pairset + offset + coverage entry worst case
    if (size + setSize > 60000) flush();
    chunk.push(f);
    size += setSize;
  }
  flush();
  return out;
}

/**
 * PairPos format 2 (class based). `classOf` maps glyphs to classes 1..n (shared by both
 * sides); `values` holds non-zero adjustments by [leftClass][rightClass].
 * Split by left classes so each subtable stays under 64 KB.
 */
export function pairPosClassTables(classOf: Map<number, number>, values: Map<number, Map<number, number>>): Uint8Array[] {
  const nClasses = Math.max(0, ...classOf.values());
  const glyphsByClass = new Map<number, number[]>();
  for (const [g, c] of classOf) {
    const arr = glyphsByClass.get(c) ?? [];
    arr.push(g);
    glyphsByClass.set(c, arr);
  }
  const leftClasses = [...values.keys()].filter((c) => values.get(c)!.size > 0 && glyphsByClass.has(c)).sort((a, b) => a - b);
  if (!leftClasses.length) return [];
  const class2Count = nClasses + 1;
  const rowBytes = class2Count * 2;
  const perTable = Math.max(1, Math.floor(56000 / rowBytes) - 1);
  const class2 = classDef(classOf);
  const out: Uint8Array[] = [];
  for (let i = 0; i < leftClasses.length; i += perTable) {
    const chunk = leftClasses.slice(i, i + perTable);
    const local = new Map<number, number>();
    const cov: number[] = [];
    chunk.forEach((c, k) => {
      for (const g of glyphsByClass.get(c)!) {
        local.set(g, k + 1);
        cov.push(g);
      }
    });
    const b = new Block();
    b.w.u16(2);
    b.offset16(coverage(cov), 'PairPos2 coverage');
    b.w.u16(0x0004).u16(0x0000);
    b.offset16(classDef(local), 'PairPos2 classDef1');
    b.offset16(class2, 'PairPos2 classDef2');
    b.w.u16(chunk.length + 1).u16(class2Count);
    for (let r = 0; r < class2Count; r++) b.w.i16(0); // class1 = 0 row
    for (const c of chunk) {
      const row = values.get(c)!;
      for (let r = 0; r < class2Count; r++) b.w.i16(row.get(r) ?? 0);
    }
    out.push(b.finish());
  }
  return out;
}

export interface MarkGlyph {
  gid: number;
  cls: number;
  anchor: Pt;
}
export interface BaseGlyph {
  gid: number;
  anchors: (Pt | null)[]; // indexed by class
}

export function markBasePosTables(marks: MarkGlyph[], bases: BaseGlyph[], classCount: number): Uint8Array[] {
  if (!marks.length || !bases.length) return [];
  const markSorted = marks.slice().sort((a, b) => a.gid - b.gid);
  const baseSorted = bases.slice().sort((a, b) => a.gid - b.gid);
  const out: Uint8Array[] = [];
  const CHUNK = 1500;
  for (let i = 0; i < baseSorted.length; i += CHUNK) {
    const chunk = baseSorted.slice(i, i + CHUNK);
    const b = new Block();
    b.w.u16(1);
    b.offset16(coverage(markSorted.map((m) => m.gid)), 'mark coverage');
    b.offset16(coverage(chunk.map((x) => x.gid)), 'base coverage');
    b.w.u16(classCount);
    // MarkArray
    const ma = new Block();
    ma.w.u16(markSorted.length);
    for (const m of markSorted) {
      ma.w.u16(m.cls);
      ma.offset16(anchor(m.anchor), 'mark anchor');
    }
    b.offset16(ma.finish(), 'MarkArray');
    // BaseArray: anchors offsets relative to BaseArray start; share anchors by value.
    const ba = new Block();
    ba.w.u16(chunk.length);
    const cache = new Map<string, Uint8Array>();
    for (const base of chunk) {
      for (let c = 0; c < classCount; c++) {
        const p = base.anchors[c];
        if (!p) {
          ba.w.u16(0);
          continue;
        }
        const key = `${Math.round(p.x)},${Math.round(p.y)}`;
        let a = cache.get(key);
        if (!a) {
          a = anchor(p);
          cache.set(key, a);
        }
        ba.offset16(a, 'base anchor');
      }
    }
    b.offset16(ba.finish(), 'BaseArray');
    out.push(b.finish());
  }
  return out;
}

// ------------------------------------------------------------------ table assembly

export interface LookupDef {
  type: number; // real lookup type
  flag: number;
  subtables: Uint8Array[];
}

export interface FeatureDef {
  tag: string;
  lookups: number[]; // indices into lookup list
}

export function buildLayoutTable(kind: 'GSUB' | 'GPOS', scripts: string[], features: FeatureDef[], lookups: LookupDef[]): Uint8Array {
  const extType = kind === 'GSUB' ? 7 : 9;
  const feats = features.filter((f) => f.lookups.length > 0).sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  // ScriptList
  const sl = new Block();
  const scriptTags = [...new Set(scripts)].sort();
  sl.w.u16(scriptTags.length);
  const langSys = new Writer(8);
  langSys.u16(0).u16(0xffff).u16(feats.length);
  for (let i = 0; i < feats.length; i++) langSys.u16(i);
  const langSysBytes = langSys.toBytes();
  const scriptTable = new Writer(8).u16(4).u16(0).bytes(langSysBytes).toBytes(); // defaultLangSys at offset 4
  for (const t of scriptTags) {
    sl.w.tag(t);
    sl.offset16(scriptTable, 'Script');
  }
  const scriptList = sl.finish();

  // FeatureList
  const fl = new Block();
  fl.w.u16(feats.length);
  for (const f of feats) {
    fl.w.tag(f.tag);
    const fw = new Writer(8).u16(0).u16(f.lookups.length);
    for (const l of f.lookups) fw.u16(l);
    fl.offset16(fw.toBytes(), 'Feature');
  }
  const featureList = fl.finish();

  // LookupList: headers + extension stubs first, real subtables in a trailing blob.
  const headerLen = 10;
  const lookupListStart = headerLen + scriptList.length + featureList.length;
  const lookupTables: Writer[] = [];
  const stubFixups: { lookup: number; stubPos: number; data: Uint8Array }[] = [];
  for (let li = 0; li < lookups.length; li++) {
    const l = lookups[li]!;
    const w = new Writer(16);
    w.u16(extType).u16(l.flag).u16(l.subtables.length);
    const offsPos = w.pos;
    for (let s = 0; s < l.subtables.length; s++) w.u16(0);
    for (let s = 0; s < l.subtables.length; s++) {
      w.setU16(offsPos + s * 2, off16(w.pos, 'ext stub'));
      const stubPos = w.pos;
      w.u16(1).u16(l.type).u32(0);
      stubFixups.push({ lookup: li, stubPos, data: l.subtables[s]! });
    }
    lookupTables.push(w);
  }
  const llHeader = new Writer(4 + lookups.length * 2);
  llHeader.u16(lookups.length);
  let cursor = 2 + lookups.length * 2;
  const lookupStarts: number[] = [];
  for (const w of lookupTables) {
    llHeader.u16(off16(cursor, 'LookupList'));
    lookupStarts.push(cursor);
    cursor += w.length;
  }
  const lookupListLen = cursor;
  // Data blob after LookupList; patch 32-bit extension offsets (relative to the stub).
  let blobCursor = lookupListStart + lookupListLen;
  const blobParts: Uint8Array[] = [];
  for (const fx of stubFixups) {
    const pad = (4 - (blobCursor % 2)) % 2; // keep subtables 2-byte aligned
    if (pad) {
      blobParts.push(new Uint8Array(pad));
      blobCursor += pad;
    }
    const stubAbs = lookupListStart + lookupStarts[fx.lookup]! + fx.stubPos;
    lookupTables[fx.lookup]!.setU32(fx.stubPos + 4, blobCursor - stubAbs);
    blobParts.push(fx.data);
    blobCursor += fx.data.length;
  }

  const head = new Writer(10);
  head.u16(1).u16(0);
  head.u16(off16(headerLen, `${kind} scriptList`));
  head.u16(off16(headerLen + scriptList.length, `${kind} featureList`));
  head.u16(off16(lookupListStart, `${kind} lookupList`));
  return concat([head.toBytes(), scriptList, featureList, llHeader.toBytes(), ...lookupTables.map((w) => w.toBytes()), ...blobParts]);
}

export function buildGDEF(glyphClasses: Map<number, number>): Uint8Array {
  const cd = classDef(glyphClasses);
  const w = new Writer(12 + cd.length);
  w.u16(1).u16(0).u16(12).u16(0).u16(0).u16(0);
  w.bytes(cd);
  return w.toBytes();
}
