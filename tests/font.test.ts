import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import * as hb from 'harfbuzzjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildFontFiles, buildFontSpec } from '../src/shared/font/build';
import { parseSvgPath, outlineToSvgPath, normaliseWinding, polygonArea, flatten } from '../src/shared/font/path';
import { DEFAULT_SETTINGS, type BuildInput } from '../src/shared/types';
import { glyphFor, rect, ring } from './helpers/synth';

const OUT = join(__dirname, '.out');
mkdirSync(OUT, { recursive: true });

const brotli = (d: Uint8Array) => new Uint8Array(brotliCompressSync(d, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));

function validate(path: string) {
  const out = execFileSync('python', [join(__dirname, 'helpers', 'validate_font.py'), path], { encoding: 'utf8' });
  return JSON.parse(out);
}

function shape(font: Uint8Array, text: string, features?: string) {
  const blob = new hb.Blob(font.slice().buffer);
  const face = new hb.Face(blob);
  const f = new hb.Font(face);
  const buf = new hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  hb.shape(f, buf, features ? features.split(',').map((x) => hb.Feature.fromString(x)!) : undefined);
  const infos = buf.getGlyphInfos();
  const pos = buf.getGlyphPositions();
  return infos.map((g, i) => ({ g: g.codepoint, cl: g.cluster, ...pos[i]! }));
}

const LATIN = ['T', 'o', 'O', 'A', 'V', 'i', 'l', '.', 'a', 'e', 'f', 'n', 'h'];
const MARKS = ['́', '̂', '̣'];
const COMPOSED = ['é', 'á', 'í', 'ấ', 'ạ', 'ô'];
const DEVA = ['क', 'ष', 'र', '्', 'ि', 'ा', 'क्ष', 'क्‍'];

function input(): BuildInput {
  const keys = [...LATIN, ...MARKS, ...COMPOSED, ...DEVA];
  const samples: BuildInput['samples'] = [];
  for (const k of [...LATIN, ...MARKS]) {
    const n = k === 'a' || k === 'e' ? 3 : k === 'l' ? 2 : 1;
    for (let v = 0; v < n; v++) samples.push({ key: k, path: glyphFor(k, v) });
  }
  // Devanagari stand-ins: headline + stems
  const deva = (w: number) => rect(300, 560, 300 + w, 620) + rect(300 + w - 70, 0, 300 + w, 560);
  samples.push({ key: 'क', path: deva(380) + ring(420, 300, 90, 120, 40) });
  samples.push({ key: 'ष', path: deva(360) });
  samples.push({ key: 'र', path: rect(400, 200, 470, 560) + rect(400, 560, 600, 620) });
  samples.push({ key: '्', path: `M620 -60L700 -200L740 -180L660 -40Z` });
  samples.push({ key: 'ि', path: rect(300, 0, 370, 560) + rect(300, 560, 900, 620) });
  samples.push({ key: 'ा', path: rect(500, 0, 570, 620) });
  samples.push({ key: 'क्ष', path: deva(560) + ring(500, 250, 100, 120, 40) });
  samples.push({ key: 'क्‍', path: rect(300, 560, 600, 620) + ring(420, 300, 90, 120, 40) });
  return {
    settings: { ...DEFAULT_SETTINGS, familyName: 'Jibun Test' },
    characters: keys.map((key) => ({ key, adjust: key === 'V' ? { lsb: 10 } : null })),
    samples,
    ligatures: [{ id: 'l1', sequence: 'fi', overlap: 60 }],
  };
}

describe('path utilities', () => {
  it('parses relative potrace-style paths and round-trips', () => {
    const o = parseSvgPath('M121 214 c-26 -21 -31 -33 -31 -69 0 -58 41 -95 105 -95z m117 -36 l10 0 0 10z');
    expect(o).toHaveLength(2);
    expect(o[0]!.segs[0]!.t).toBe('C');
    expect(o[0]!.segs[1]).toMatchObject({ t: 'C', p: { x: 195, y: 50 } });
    const back = parseSvgPath(outlineToSvgPath(o, 3));
    expect(back[1]!.segs).toHaveLength(2);
  });

  it('normalises winding: outer clockwise and hole counter-clockwise for TrueType', () => {
    const o = parseSvgPath(ring(500, 300, 200, 200, 50));
    const n = normaliseWinding(o, 'cw');
    const areas = n.map((c) => polygonArea(flatten(c)));
    const outer = areas.reduce((a, b) => (Math.abs(a) > Math.abs(b) ? a : b));
    const inner = areas.find((a) => a !== outer)!;
    expect(outer).toBeLessThan(0);
    expect(inner).toBeGreaterThan(0);
  });
});

describe('font build', () => {
  let files: Awaited<ReturnType<typeof buildFontFiles>>;
  beforeAll(async () => {
    files = await buildFontFiles(input(), ['ttf', 'otf', 'woff2'], brotli, { created: new Date('2026-11-17T00:00:00Z') });
    writeFileSync(join(OUT, 'test.ttf'), files.files.ttf!);
    writeFileSync(join(OUT, 'test.otf'), files.files.otf!);
    writeFileSync(join(OUT, 'test.woff2'), files.files.woff2!);
  });

  it('reports composed characters and nothing missing', () => {
    expect(files.report.missing).toEqual([]);
    expect(files.report.composed.sort()).toEqual([...COMPOSED].sort());
    expect(files.report.alternates).toBe(5);
    expect(files.report.kerningPairs).toBeGreaterThan(0);
  });

  for (const ext of ['ttf', 'otf', 'woff2'] as const) {
    it(`${ext} decompiles cleanly in fontTools`, () => {
      const s = validate(join(OUT, `test.${ext}`));
      expect(s.unitsPerEm).toBe(1000);
      expect(s.name).toBe('Jibun Test Regular');
      expect(s.GSUB.features).toEqual(expect.arrayContaining(['akhn', 'calt', 'half', 'liga', 'pres']));
      expect(s.GPOS.features).toEqual(expect.arrayContaining(['kern', 'mark', 'abvm', 'blwm']));
      expect(s.GSUB.scripts).toEqual(expect.arrayContaining(['DFLT', 'latn', 'dev2']));
      if (ext !== 'otf') expect(s.lsbMismatch).toEqual([]);
      expect(s.cmapSize).toBeGreaterThan(25);
    });
  }

  for (const ext of ['ttf', 'otf'] as const) {
    describe(`${ext} shaping with HarfBuzz`, () => {
      const font = () => files.files[ext]!;
      it('kerns T + o tighter than default spacing', () => {
        const kerned = shape(font(), 'To');
        const plain = shape(font(), 'To', '-kern');
        expect(kerned[0]!.xAdvance).toBeLessThan(plain[0]!.xAdvance - 20);
      });
      it('cycles alternates for repeated letters', () => {
        const r = shape(font(), 'aaaa');
        const ids = r.map((x) => x.g);
        expect(new Set(ids).size).toBeGreaterThanOrEqual(2);
        expect(ids[0]).not.toBe(ids[1]);
        const noCalt = shape(font(), 'aaaa', '-calt');
        expect(new Set(noCalt.map((x) => x.g)).size).toBe(1);
      });
      it('forms the fi ligature', () => {
        expect(shape(font(), 'fi')).toHaveLength(1);
      });
      it('maps precomposed letters to composed glyphs', () => {
        const r = shape(font(), 'éấ');
        expect(r).toHaveLength(2);
        expect(r.every((x) => x.g !== 0)).toBe(true);
      });
      it('positions decomposed combining marks above the base', () => {
        const r = shape(font(), 'T́');
        expect(r).toHaveLength(2);
        expect(r[1]!.yOffset).toBeGreaterThan(100);
      });
      it('substitutes the Devanagari conjunct क्ष', () => {
        const r = shape(font(), 'क्ष');
        expect(r).toHaveLength(1);
        expect(r[0]!.g).not.toBe(0);
      });
      it('uses half forms before a consonant', () => {
        const r = shape(font(), 'क्र');
        expect(r.every((x) => x.g !== 0)).toBe(true);
      });
      it('reorders the i-matra before the consonant', () => {
        const ki = shape(font(), 'कि');
        const iMatra = shape(font(), 'ि');
        expect(ki[0]!.g).toBe(iMatra[iMatra.length - 1]!.g);
      });
    });
  }

  it('builds deterministic output for identical input', async () => {
    const a = await buildFontFiles(input(), ['ttf'], null, { created: new Date(0) });
    const b = await buildFontFiles(input(), ['ttf'], null, { created: new Date(0) });
    expect(Buffer.from(a.files.ttf!).equals(Buffer.from(b.files.ttf!))).toBe(true);
  });

  it('handles a large character set (2,000 glyphs) within limits', () => {
    const keys: string[] = [];
    for (let c = 0x4e00; keys.length < 2000; c++) keys.push(String.fromCodePoint(c));
    const t0 = Date.now();
    const { spec, report } = buildFontSpec({
      settings: DEFAULT_SETTINGS,
      characters: keys.map((key) => ({ key })),
      samples: keys.map((key) => ({ key, path: glyphFor(key) })),
      ligatures: [],
    });
    expect(report.glyphCount).toBe(2002);
    expect(spec.glyphs.length).toBe(2002);
    expect(Date.now() - t0).toBeLessThan(20000);
  });
});
