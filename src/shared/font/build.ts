/**
 * Turns captured samples and settings into a complete FontSpec: spacing, composed
 * accented letters, alternates (calt), ligatures (liga), Devanagari shaping
 * features, mark attachment and automatic kerning.
 */
import { BOX_W_UNITS, METRICS, UNITS_PER_EM, referenceCircle } from '../layout';
import { DEFAULT_SETTINGS, LIMITS, type BuildInput, type ExportFormat, type FontSettings, type GlyphAdjust } from '../types';
import {
  RA,
  VIRAMA,
  NUKTA,
  codepoints,
  decomposition,
  glyphName,
  isSingle,
  keyKind,
  scriptOf,
  scriptOfKey,
  type ScriptGroup,
} from '../unicode';
import { autoKern } from './kerning';
import {
  chainContextFormat3,
  ligatureSubstTables,
  markBasePosTables,
  pairPosClassTables,
  singleSubst,
  uniqSorted,
  type BaseGlyph,
  type FeatureDef,
  type Ligature,
  type LookupDef,
  type MarkGlyph,
} from './otl';
import { emptyBBox, isEmptyBBox, outlineBBox, parseSvgPath, scaleAbout, translate, type BBox, type Outline, type Pt } from './path';
import { compileFont, type FontSpec, type GlyphSpec } from './sfnt';
import { encodeWOFF2, type BrotliCompress } from './woff2';

export interface BuildReport {
  glyphCount: number;
  mappedCharacters: number;
  composed: string[];
  missing: string[];
  alternates: number;
  kerningPairs: number;
  ligatures: number;
}

const MARK_ABOVE = 0;
const MARK_BELOW = 1;
const MARK_HORN = 2;
const MARK_OGONEK = 3;
const MARK_CLASSES = 4;

interface Placed {
  key: string;
  variant: number;
  outline: Outline;
  advance: number;
  bbox: BBox;
  isMark: boolean;
  markClass: number;
  markAnchor: Pt | null;
}

export function normaliseSettings(s: Partial<FontSettings> | null | undefined): FontSettings {
  const v = { ...DEFAULT_SETTINGS, ...(s ?? {}) };
  const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  return {
    familyName: (typeof v.familyName === 'string' && v.familyName.trim() ? v.familyName.trim() : DEFAULT_SETTINGS.familyName).slice(0, 60),
    sidebearing: num(v.sidebearing, DEFAULT_SETTINGS.sidebearing, -100, 400),
    tracking: num(v.tracking, 0, -200, 400),
    baselineShift: num(v.baselineShift, 0, -400, 400),
    scale: num(v.scale, 1, 0.3, 3),
    spaceWidth: num(v.spaceWidth, DEFAULT_SETTINGS.spaceWidth, 50, 1500),
    lineGap: num(v.lineGap, DEFAULT_SETTINGS.lineGap, 0, 1500),
    kerning: v.kerning !== false,
    kerningStrength: num(v.kerningStrength, 1, 0, 2),
    alternates: v.alternates !== false,
    autoCompose: v.autoCompose !== false,
  };
}

function markClassFor(cp: number, position: 'above' | 'below' | 'auto'): number {
  if (cp === 0x031b) return MARK_HORN;
  if (cp === 0x0328) return MARK_OGONEK;
  return position === 'below' ? MARK_BELOW : MARK_ABOVE;
}

function sidebearingFor(key: string, s: FontSettings): number {
  const script = scriptOfKey(key);
  if (script === 'devanagari') return Math.min(s.sidebearing, 8) + s.tracking;
  return s.sidebearing + s.tracking;
}

/** Position a raw cell outline as a glyph. */
function place(key: string, variant: number, raw: Outline, adjust: GlyphAdjust | null | undefined, s: FontSettings): Placed | null {
  const scale = s.scale * (adjust?.scale ?? 1);
  const dy = s.baselineShift + (adjust?.baseline ?? 0);
  const kind = keyKind(key);
  let o = scaleAbout(raw, scale, BOX_W_UNITS / 2, 0);
  o = translate(o, 0, dy);
  const bb = outlineBBox(o);
  if (isEmptyBBox(bb)) return null;
  if (kind.kind === 'mark' || kind.kind === 'reph' || kind.kind === 'rakar') {
    const ref = referenceCircle(key);
    const shifted = translate(o, -ref.right, 0);
    const cp = codepoints(key)[0]!;
    const position = kind.kind === 'mark' ? kind.position : kind.kind === 'reph' ? 'above' : 'below';
    const cls = kind.kind === 'mark' ? markClassFor(cp, position) : position === 'below' ? MARK_BELOW : MARK_ABOVE;
    const anchorX = cls === MARK_HORN || cls === MARK_OGONEK ? 0 : ref.cx - ref.right;
    const anchorY = cls === MARK_BELOW || cls === MARK_OGONEK ? ref.bottom + dy : ref.top + dy;
    return { key, variant, outline: shifted, advance: 0, bbox: outlineBBox(shifted), isMark: true, markClass: cls, markAnchor: { x: anchorX, y: anchorY } };
  }
  const sb = sidebearingFor(key, s);
  const lsb = sb + (adjust?.lsb ?? 0);
  const rsb = sb + (adjust?.rsb ?? 0);
  const width = bb.xMax - bb.xMin;
  let dx = lsb - bb.xMin;
  let advance = Math.max(0, lsb + width + rsb);
  if (scriptOfKey(key) === 'kana') {
    const full = Math.max(UNITS_PER_EM * s.scale, width + 2 * sb);
    dx = (full - width) / 2 - bb.xMin;
    advance = full;
  }
  const out = translate(o, dx, 0);
  return { key, variant, outline: out, advance: Math.round(advance), bbox: outlineBBox(out), isMark: false, markClass: -1, markAnchor: null };
}

function baseAnchors(bb: BBox, script: ScriptGroup): (Pt | null)[] {
  if (isEmptyBBox(bb)) return [null, null, null, null];
  const cx = (bb.xMin + bb.xMax) / 2;
  const topRef = script === 'devanagari' ? METRICS.devanagariHeadline : METRICS.xHeight;
  return [
    { x: cx, y: Math.max(bb.yMax, topRef) },
    { x: cx, y: Math.min(bb.yMin, 0) },
    { x: bb.xMax, y: Math.max(bb.yMax, topRef) },
    { x: bb.xMax - (bb.xMax - bb.xMin) * 0.15, y: Math.min(bb.yMin, 0) },
  ];
}

function notdef(): Outline {
  const r = (x0: number, y0: number, x1: number, y1: number) => ({
    start: { x: x0, y: y0 },
    segs: [
      { t: 'L' as const, p: { x: x0, y: y1 } },
      { t: 'L' as const, p: { x: x1, y: y1 } },
      { t: 'L' as const, p: { x: x1, y: y0 } },
    ],
  });
  return [r(50, 0, 450, 700), r(100, 50, 400, 650)];
}

function removeDot(o: Outline): Outline {
  // Drop small contours sitting entirely above the x-height (the tittle of i/j).
  if (o.length < 2) return o;
  const parts = o.map((c) => ({ c, b: outlineBBox([c]) }));
  const kept = parts.filter(({ b }) => !(b.yMin > METRICS.xHeight * 0.75));
  return kept.length ? kept.map((p) => p.c) : o;
}

function scriptTag(g: ScriptGroup): string[] {
  switch (g) {
    case 'latin':
      return ['latn'];
    case 'greek':
      return ['grek'];
    case 'cyrillic':
      return ['cyrl'];
    case 'devanagari':
      return ['dev2', 'deva'];
    case 'kana':
      return ['kana'];
    default:
      return [];
  }
}

const KERNABLE: ScriptGroup[] = ['latin', 'greek', 'cyrillic', 'common'];
const MAX_KERN_CHARS = 420;

export function buildFontSpec(input: BuildInput, opts: { created?: Date } = {}): { spec: FontSpec; report: BuildReport } {
  const s = normaliseSettings(input.settings);
  const subset = input.subset ? new Set(input.subset) : null;
  const adjustOf = new Map<string, GlyphAdjust | null | undefined>();
  const charKeys: string[] = [];
  for (const c of input.characters) {
    if (subset && !subset.has(c.key)) continue;
    if (!adjustOf.has(c.key)) charKeys.push(c.key);
    adjustOf.set(c.key, c.adjust);
  }

  // Group samples per key in order.
  const samplesByKey = new Map<string, Outline[]>();
  for (const sm of input.samples) {
    if (!adjustOf.has(sm.key)) continue;
    let o: Outline;
    try {
      o = parseSvgPath(sm.path);
    } catch {
      continue;
    }
    if (!o.length) continue;
    const arr = samplesByKey.get(sm.key) ?? [];
    if (arr.length < LIMITS.maxSamplesPerChar) arr.push(o);
    samplesByKey.set(sm.key, arr);
  }

  const glyphs: GlyphSpec[] = [];
  const gidOf = new Map<string, number>(); // glyph name -> gid
  const placedOf = new Map<number, Placed>();
  const scriptsUsed = new Set<ScriptGroup>(['latin']);

  const add = (g: GlyphSpec, placed?: Placed): number => {
    const gid = glyphs.length;
    glyphs.push(g);
    gidOf.set(g.name, gid);
    if (placed) placedOf.set(gid, placed);
    return gid;
  };

  add({ name: '.notdef', unicodes: [], advance: 500, outline: notdef() });
  const usedCps = new Set<number>();
  const spaceCps = [0x20, 0xa0].filter((c) => !charKeys.includes(String.fromCodePoint(c)));
  add({ name: 'space', unicodes: spaceCps, advance: Math.round(s.spaceWidth + 2 * s.tracking), outline: [] });
  spaceCps.forEach((c) => usedCps.add(c));

  // Place every sample.
  const variantsOf = new Map<string, Placed[]>();
  for (const key of charKeys) {
    const raws = samplesByKey.get(key);
    if (!raws) continue;
    const placed = raws.map((r, i) => place(key, i, r, adjustOf.get(key), s)).filter((p): p is Placed => p !== null);
    if (placed.length) variantsOf.set(key, placed);
  }

  // Base glyphs (variant 0) in character order.
  const baseGid = new Map<string, number>();
  for (const key of charKeys) {
    const v = variantsOf.get(key);
    if (!v) continue;
    const p = v[0]!;
    const cps = codepoints(key);
    const unicodes = isSingle(key) && !usedCps.has(cps[0]!) ? [cps[0]!] : [];
    unicodes.forEach((u) => usedCps.add(u));
    cps.forEach((c) => scriptsUsed.add(scriptOf(c)));
    const gid = add({ name: glyphName(key), unicodes, advance: p.advance, outline: p.outline, gdefClass: p.isMark ? 3 : unicodes.length ? 1 : 2 }, p);
    baseGid.set(key, gid);
  }

  // Composed accented characters.
  const composed: string[] = [];
  const missing: string[] = [];
  if (s.autoCompose) {
    for (const key of charKeys) {
      if (baseGid.has(key)) continue;
      const d = decomposition(key);
      if (!d) continue;
      const base = variantsOf.get(d.base)?.[0];
      const marks = d.marks.map((m) => variantsOf.get(m)?.[0]);
      if (!base || base.isMark || marks.some((m) => !m || !m.isMark)) continue;
      let outline = base.outline;
      const hasAbove = marks.some((m) => m!.markClass === MARK_ABOVE);
      if (hasAbove && (d.base === 'i' || d.base === 'j')) outline = removeDot(outline);
      const bb = outlineBBox(outline);
      const anchors = baseAnchors(bb, scriptOfKey(d.base));
      let aboveTop: number | null = null;
      let belowBottom: number | null = null;
      for (const m of marks as Placed[]) {
        const anc = anchors[m.markClass]!;
        if (!anc) continue;
        let dx = anc.x - m.markAnchor!.x;
        let dy = anc.y - m.markAnchor!.y;
        const mb = m.bbox;
        if (m.markClass === MARK_ABOVE && aboveTop !== null) dy = Math.max(dy, aboveTop + 40 - mb.yMin);
        if (m.markClass === MARK_BELOW && belowBottom !== null) dy = Math.min(dy, belowBottom - 40 - mb.yMax);
        if (m.markClass === MARK_ABOVE) dx = anc.x - (mb.xMin + mb.xMax) / 2; // centre precisely over the base
        const moved = translate(m.outline, dx, dy);
        const movedBB = outlineBBox(moved);
        if (m.markClass === MARK_ABOVE) aboveTop = movedBB.yMax;
        if (m.markClass === MARK_BELOW) belowBottom = movedBB.yMin;
        outline = [...outline, ...moved];
      }
      const cp = codepoints(key)[0]!;
      if (usedCps.has(cp)) continue;
      usedCps.add(cp);
      scriptsUsed.add(scriptOf(cp));
      const gid = add({ name: glyphName(key), unicodes: [cp], advance: base.advance, outline, gdefClass: 1 }, {
        ...base,
        key,
        outline,
        bbox: outlineBBox(outline),
      });
      baseGid.set(key, gid);
      composed.push(key);
    }
  }
  for (const key of charKeys) if (!baseGid.has(key)) missing.push(key);

  // User ligatures composed from captured glyphs.
  const ligs: { feature: string; lig: Ligature }[] = [];
  let userLigCount = 0;
  for (const l of input.ligatures.slice(0, LIMITS.maxLigatures)) {
    const parts = Array.from(l.sequence.normalize('NFC'));
    if (parts.length < 2) continue;
    const comps = parts.map((p) => variantsOf.get(p)?.[0]).filter((p): p is Placed => !!p && !p.isMark);
    if (comps.length !== parts.length) continue;
    const name = `${glyphName(l.sequence)}.liga`;
    if (gidOf.has(name)) continue;
    let x = 0;
    let outline: Outline = [];
    comps.forEach((c, i) => {
      outline = [...outline, ...translate(c.outline, x, 0)];
      x += c.advance - (i < comps.length - 1 ? l.overlap : 0);
    });
    const gid = add({ name, unicodes: [], advance: Math.max(0, Math.round(x)), outline, gdefClass: 2 }, {
      ...comps[0]!,
      key: l.sequence,
      outline,
      advance: Math.round(x),
      bbox: outlineBBox(outline),
    });
    ligs.push({ feature: 'liga', lig: { components: parts.map((p) => baseGid.get(p)!), glyph: gid } });
    userLigCount++;
  }

  // Sequence keys written in cells (conjuncts, half forms, custom sequences) become ligatures.
  for (const key of charKeys) {
    if (isSingle(key)) continue;
    const gid = baseGid.get(key);
    if (gid === undefined) continue;
    const cps = codepoints(key).filter((c) => c !== 0x200d);
    const comps = cps.map((c) => baseGid.get(String.fromCodePoint(c)));
    // Every code point needs a glyph so shaping can find the sequence in the buffer.
    if (comps.some((c) => c === undefined)) {
      // Fallback: still reachable if components are mapped by cmap later; skip otherwise.
      continue;
    }
    const kind = keyKind(key).kind;
    const feature =
      kind === 'half' ? 'half' : kind === 'reph' ? 'rphf' : kind === 'rakar' ? 'blwf' : kind === 'conjunct' ? 'akhn' : kind === 'nukta-form' ? 'nukt' : 'liga';
    ligs.push({ feature, lig: { components: comps as number[], glyph: gid } });
    if (kind === 'rakar') ligs.push({ feature: 'rkrf', lig: { components: comps as number[], glyph: gid } });
    if (kind === 'conjunct') ligs.push({ feature: 'pres', lig: { components: comps as number[], glyph: gid } });
  }
  // Precomposed nukta letters (U+0958..095F) for decomposed input.
  for (const key of charKeys) {
    const cp = codepoints(key)[0]!;
    if (!isSingle(key) || cp < 0x0958 || cp > 0x095f) continue;
    const d = key.normalize('NFD');
    const c = codepoints(d);
    const a = baseGid.get(String.fromCodePoint(c[0]!));
    const b = baseGid.get(String.fromCodePoint(NUKTA));
    const g = baseGid.get(key);
    if (a !== undefined && b !== undefined && g !== undefined) ligs.push({ feature: 'nukt', lig: { components: [a, b], glyph: g } });
  }
  void RA;
  void VIRAMA;

  // Alternates (variants 1..3), grouped by variant index so coverage ranges stay compact.
  const variantGid = new Map<string, number[]>(); // key -> [base, v1, v2, ...]
  let alternateCount = 0;
  if (s.alternates) {
    for (let v = 1; v < LIMITS.maxSamplesPerChar; v++) {
      for (const key of charKeys) {
        const vs = variantsOf.get(key);
        const base = baseGid.get(key);
        if (!vs || base === undefined || !vs[v] || composed.includes(key)) continue;
        const p = vs[v]!;
        if (p.isMark) continue;
        const gid = add({ name: glyphName(key, v), unicodes: [], advance: p.advance, outline: p.outline, gdefClass: 1 }, p);
        const arr = variantGid.get(key) ?? [base];
        arr[v] = gid;
        variantGid.set(key, arr);
        alternateCount++;
      }
    }
  }

  if (glyphs.length > LIMITS.maxGlyphs) throw new Error(`font would have ${glyphs.length} glyphs; the OpenType limit is ${LIMITS.maxGlyphs}`);

  // ------------------------------------------------------------ GSUB
  const gsubLookups: LookupDef[] = [];
  const gsubFeatures = new Map<string, number[]>();
  const addFeatureLookup = (tag: string, idx: number) => {
    const arr = gsubFeatures.get(tag) ?? [];
    arr.push(idx);
    gsubFeatures.set(tag, arr);
  };
  for (const tag of ['nukt', 'akhn', 'rphf', 'rkrf', 'blwf', 'half', 'pres', 'liga']) {
    const list = ligs.filter((l) => l.feature === tag).map((l) => l.lig);
    if (!list.length) continue;
    gsubLookups.push({ type: 4, flag: 0, subtables: ligatureSubstTables(list) });
    addFeatureLookup(tag, gsubLookups.length - 1);
  }
  let maxContext = Math.max(1, ...ligs.map((l) => l.lig.components.length));
  if (variantGid.size) {
    // One single-substitution lookup per variant index.
    const K = Math.max(...[...variantGid.values()].map((a) => a.length));
    const singleIdx: number[] = [];
    for (let v = 1; v < K; v++) {
      const map = new Map<number, number>();
      for (const arr of variantGid.values()) if (arr[v] !== undefined) map.set(arr[0]!, arr[v]!);
      singleIdx[v] = gsubLookups.length;
      gsubLookups.push({ type: 1, flag: 0, subtables: [singleSubst(map)] });
    }
    // Index of each glyph within its variant cycle.
    const idxGlyphs: number[][] = Array.from({ length: K }, () => []);
    for (const g of baseGid.values()) idxGlyphs[0]!.push(g);
    idxGlyphs[0]!.push(1); // space
    for (const arr of variantGid.values()) arr.forEach((g, v) => v > 0 && g !== undefined && idxGlyphs[v]!.push(g));
    const rules: Uint8Array[] = [];
    for (let j = 0; j < K; j++) {
      const byTarget = new Map<number, number[]>();
      for (const arr of variantGid.values()) {
        const k = arr.filter((x) => x !== undefined).length;
        const m = (j + 1) % k;
        if (m === 0 || arr[m] === undefined) continue;
        const list = byTarget.get(m) ?? [];
        list.push(arr[0]!);
        byTarget.set(m, list);
      }
      for (const [m, inputs] of byTarget) {
        if (!idxGlyphs[j]!.length) continue;
        rules.push(chainContextFormat3({ backtrack: [uniqSorted(idxGlyphs[j]!)], input: [uniqSorted(inputs)], lookahead: [], lookups: [{ sequenceIndex: 0, lookupIndex: singleIdx[m]! }] }));
      }
    }
    if (rules.length) {
      gsubLookups.push({ type: 6, flag: 0x0008, subtables: rules });
      addFeatureLookup('calt', gsubLookups.length - 1);
      maxContext = Math.max(maxContext, 2);
    }
  }

  // ------------------------------------------------------------ GPOS
  const gposLookups: LookupDef[] = [];
  const gposFeatures = new Map<string, number[]>();
  let kerningPairs = 0;
  if (s.kerning) {
    const kernKeys = charKeys.filter((k) => {
      const v = variantsOf.get(k);
      return isSingle(k) && v && !v[0]!.isMark && KERNABLE.includes(scriptOfKey(k)) && baseGid.has(k);
    });
    const chosen = kernKeys.slice(0, MAX_KERN_CHARS);
    const classOf = new Map<number, number>();
    const kg = chosen.map((k, i) => {
      const cls = i + 1;
      const gids = variantGid.get(k) ?? [baseGid.get(k)!];
      for (const g of gids) if (g !== undefined) classOf.set(g, cls);
      const p = placedOf.get(baseGid.get(k)!)!;
      return { id: cls, outline: p.outline, advance: p.advance };
    });
    // Composed accented letters kern like their base letter.
    const classOfKey = new Map(chosen.map((k, i) => [k, i + 1]));
    for (const key of composed) {
      const d = decomposition(key);
      const cls = d ? classOfKey.get(d.base) : undefined;
      const gid = baseGid.get(key);
      if (cls !== undefined && gid !== undefined) classOf.set(gid, cls);
    }
    const values = autoKern(kg, s.kerningStrength);
    for (const row of values.values()) kerningPairs += row.size;
    const tables = pairPosClassTables(classOf, values);
    if (tables.length) {
      gposLookups.push({ type: 2, flag: 0x0008, subtables: tables });
      gposFeatures.set('kern', [gposLookups.length - 1]);
    }
  }
  const markGlyphs: MarkGlyph[] = [];
  const baseGlyphs: BaseGlyph[] = [];
  for (const [gid, p] of placedOf) {
    if (p.isMark && p.markAnchor) markGlyphs.push({ gid, cls: p.markClass, anchor: p.markAnchor });
    else if (!p.isMark && p.outline.length) baseGlyphs.push({ gid, anchors: baseAnchors(outlineBBox(glyphs[gid]!.outline), scriptOfKey(p.key)) });
  }
  const markTables = markBasePosTables(markGlyphs, baseGlyphs, MARK_CLASSES);
  if (markTables.length) {
    gposLookups.push({ type: 4, flag: 0, subtables: markTables });
    const idx = gposLookups.length - 1;
    gposFeatures.set('mark', [idx]);
    if (scriptsUsed.has('devanagari')) {
      gposFeatures.set('abvm', [idx]);
      gposFeatures.set('blwm', [idx]);
    }
  }

  const scripts = ['DFLT', ...[...scriptsUsed].flatMap(scriptTag)];
  const toFeatures = (m: Map<string, number[]>): FeatureDef[] => [...m.entries()].map(([tag, lookups]) => ({ tag, lookups }));

  // Vertical metrics from actual ink so nothing is clipped.
  let fontBB = emptyBBox();
  for (const g of glyphs) {
    const b = outlineBBox(g.outline);
    if (isEmptyBBox(b)) continue;
    fontBB = isEmptyBBox(fontBB) ? b : { xMin: Math.min(fontBB.xMin, b.xMin), yMin: Math.min(fontBB.yMin, b.yMin), xMax: Math.max(fontBB.xMax, b.xMax), yMax: Math.max(fontBB.yMax, b.yMax) };
  }
  const scaleS = s.scale;
  const ascender = Math.round(Math.max(METRICS.ascender * scaleS, 750));
  const descender = Math.round(Math.min(METRICS.descender * scaleS, -200));

  const spec: FontSpec = {
    familyName: s.familyName,
    styleName: 'Regular',
    version: '1.000',
    unitsPerEm: UNITS_PER_EM,
    ascender,
    descender,
    lineGap: Math.round(s.lineGap),
    xHeight: Math.round(METRICS.xHeight * scaleS),
    capHeight: Math.round(METRICS.capHeight * scaleS),
    glyphs,
    gsub: gsubLookups.length ? { scripts, features: toFeatures(gsubFeatures), lookups: gsubLookups } : undefined,
    gpos: gposLookups.length ? { scripts, features: toFeatures(gposFeatures), lookups: gposLookups } : undefined,
    created: opts.created,
    maxContext,
  };
  void fontBB;
  return {
    spec,
    report: {
      glyphCount: glyphs.length,
      mappedCharacters: usedCps.size,
      composed,
      missing,
      alternates: alternateCount,
      kerningPairs,
      ligatures: userLigCount,
    },
  };
}

export async function buildFontFiles(
  input: BuildInput,
  formats: ExportFormat[],
  brotli: BrotliCompress | null,
  opts: { created?: Date } = {},
): Promise<{ files: Partial<Record<ExportFormat, Uint8Array>>; report: BuildReport }> {
  const { spec, report } = buildFontSpec(input, opts);
  const files: Partial<Record<ExportFormat, Uint8Array>> = {};
  let ttf: Uint8Array | null = null;
  if (formats.includes('ttf') || formats.includes('woff2')) ttf = compileFont(spec, 'ttf');
  if (formats.includes('ttf')) files.ttf = ttf!;
  if (formats.includes('otf')) files.otf = compileFont(spec, 'otf');
  if (formats.includes('woff2')) {
    if (!brotli) throw new Error('WOFF2 requires a Brotli encoder');
    let source = ttf!;
    if (input.subset === undefined && spec.glyphs.length > 2500) {
      // Automatic subsetting for heavy web fonts: keep base glyphs and the first alternate only.
      const lean = buildFontSpec({ ...input, samples: trimAlternates(input.samples, 2) }, opts).spec;
      source = compileFont(lean, 'ttf');
    }
    files.woff2 = await encodeWOFF2(source, brotli);
  }
  return { files, report };
}

function trimAlternates(samples: BuildInput['samples'], keep: number) {
  const count = new Map<string, number>();
  return samples.filter((sm) => {
    const n = count.get(sm.key) ?? 0;
    count.set(sm.key, n + 1);
    return n < keep;
  });
}
