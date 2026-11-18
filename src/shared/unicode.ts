/**
 * Character sets, keys and classification.
 *
 * A "key" is the text a cell asks the person to write: usually one code point,
 * sometimes a sequence (Devanagari conjuncts and half forms, custom ligature cells).
 */

export const MAX_BASE_CHARACTERS = 5000;

export type ScriptGroup = 'latin' | 'greek' | 'cyrillic' | 'devanagari' | 'kana' | 'common' | 'other';

export const VIRAMA = 0x094d;
export const ZWJ = 0x200d;
export const RA = 0x0930;
export const NUKTA = 0x093c;

export function codepoints(s: string): number[] {
  return Array.from(s, (c) => c.codePointAt(0)!);
}

export function isSingle(key: string): boolean {
  return codepoints(key).length === 1;
}

const RE_MARK = /^\p{M}$/u;
const RE_NONSPACING = /^[\p{Mn}\p{Me}]$/u;
const RE_GRAPHIC = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

export function isNonSpacingMark(cp: number): boolean {
  return RE_NONSPACING.test(String.fromCodePoint(cp));
}
export function isMark(cp: number): boolean {
  return RE_MARK.test(String.fromCodePoint(cp));
}
export function isGraphic(cp: number): boolean {
  return RE_GRAPHIC.test(String.fromCodePoint(cp));
}

export function scriptOf(cp: number): ScriptGroup {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f && cp !== 0xd7 && cp !== 0xf7) || (cp >= 0x1e00 && cp <= 0x1eff))
    return 'latin';
  if (cp >= 0x370 && cp <= 0x3ff) return 'greek';
  if (cp >= 0x400 && cp <= 0x52f) return 'cyrillic';
  if (cp >= 0x900 && cp <= 0x97f) return 'devanagari';
  if (cp >= 0x3040 && cp <= 0x30ff) return 'kana';
  if (cp < 0x300 || (cp >= 0x2000 && cp <= 0x2bff)) return 'common';
  if (cp >= 0x300 && cp <= 0x36f) return 'latin';
  return 'other';
}

export function scriptOfKey(key: string): ScriptGroup {
  const cps = codepoints(key);
  for (const c of cps) {
    const s = scriptOf(c);
    if (s !== 'common') return s;
  }
  return 'common';
}

/** Glyph name for a key and variant. Uses AGL "uniXXXX" / "uXXXXX" forms, joined for sequences. */
export function glyphName(key: string, variant = 0): string {
  const cps = codepoints(key);
  let base: string;
  if (cps.every((c) => c <= 0xffff)) base = 'uni' + cps.map((c) => c.toString(16).toUpperCase().padStart(4, '0')).join('');
  else base = cps.map((c) => (c <= 0xffff ? 'uni' : 'u') + c.toString(16).toUpperCase().padStart(c <= 0xffff ? 4 : 5, '0')).join('_');
  return variant > 0 ? `${base}.alt${variant}` : base;
}

/** Describe what kind of glyph a key produces, which drives guides, spacing and GSUB features. */
export type KeyKind =
  | { kind: 'char' }
  | { kind: 'mark'; position: 'above' | 'below' | 'auto' }
  | { kind: 'spacing-mark' }
  | { kind: 'conjunct' }
  | { kind: 'half' }
  | { kind: 'reph' }
  | { kind: 'rakar' }
  | { kind: 'nukta-form' }
  | { kind: 'sequence' };

const BELOW_MARKS = new Set([0x0323, 0x0324, 0x0325, 0x0326, 0x0327, 0x0328, 0x0331, 0x0332, 0x093c, 0x0941, 0x0942, 0x0943, 0x0944, 0x094d, 0x0962, 0x0963]);

export function keyKind(key: string): KeyKind {
  const cps = codepoints(key);
  if (cps.length === 1) {
    const c = cps[0]!;
    if (isNonSpacingMark(c)) return { kind: 'mark', position: BELOW_MARKS.has(c) ? 'below' : 'above' };
    if (isMark(c)) return { kind: 'spacing-mark' };
    return { kind: 'char' };
  }
  if (cps.length === 2 && cps[0] === RA && cps[1] === VIRAMA) return { kind: 'reph' };
  if (cps.length === 2 && cps[0] === VIRAMA && cps[1] === RA) return { kind: 'rakar' };
  if (cps.length === 3 && cps[1] === VIRAMA && cps[2] === ZWJ) return { kind: 'half' };
  if (cps.length === 2 && cps[1] === NUKTA) return { kind: 'nukta-form' };
  if (cps.includes(VIRAMA)) return { kind: 'conjunct' };
  return { kind: 'sequence' };
}

/** Marks that need a dotted-circle reference in their cell. */
export function needsReference(key: string): boolean {
  const k = keyKind(key).kind;
  return k === 'mark' || k === 'spacing-mark' || k === 'reph' || k === 'rakar';
}

// ------------------------------------------------------------------ presets

export interface Preset {
  id: string;
  name: string;
  group: 'Latin' | 'Other scripts' | 'Symbols' | 'Indic' | 'Japanese';
  description: string;
  keys: () => string[];
}

const range = (a: number, b: number, filter: (cp: number) => boolean = isGraphic) => {
  const out: string[] = [];
  for (let c = a; c <= b; c++) if (filter(c)) out.push(String.fromCodePoint(c));
  return out;
};
const chars = (s: string) => Array.from(s);

const VIET_VOWELS = 'aăâeêioôơuưy';
const VIET_TONES = ['', '̀', '́', '̉', '̃', '̣'];

export function vietnameseKeys(): string[] {
  const out: string[] = [];
  for (const v of chars(VIET_VOWELS + VIET_VOWELS.toUpperCase()))
    for (const t of VIET_TONES) {
      const s = (v + t).normalize('NFC');
      if (isSingle(s)) out.push(s);
    }
  out.push('đ', 'Đ');
  return [...new Set(out)];
}

const DEVANAGARI_CONSONANTS = range(0x0915, 0x0939);
const COMMON_CONJUNCTS = [
  'क्ष', 'त्र', 'ज्ञ', 'श्र', 'द्ध', 'द्व', 'द्य', 'द्म', 'द्ग', 'द्द', 'द्भ', 'द्र', 'ह्म', 'ह्य', 'ह्र', 'ह्न', 'ह्ल', 'ह्व', 'ङ्क', 'ङ्ग',
  'क्क', 'क्त', 'क्र', 'क्ल', 'क्व', 'क्य', 'ख्य', 'ग्न', 'ग्र', 'ग्य', 'घ्र', 'च्च', 'च्छ', 'च्य', 'ज्ज', 'ज्र', 'ज्य', 'ञ्च', 'ञ्ज', 'ट्ट',
  'ट्ठ', 'ट्र', 'ठ्र', 'ड्ड', 'ड्र', 'ढ्र', 'ण्ट', 'ण्ड', 'ण्य', 'त्त', 'त्थ', 'त्न', 'त्म', 'त्य', 'त्व', 'त्स', 'थ्य', 'द्', 'ध्य', 'ध्र',
  'न्त', 'न्द', 'न्ध', 'न्न', 'न्म', 'न्य', 'न्र', 'न्ह', 'प्त', 'प्प', 'प्र', 'प्ल', 'प्य', 'ब्ज', 'ब्द', 'ब्ध', 'ब्र', 'ब्य', 'भ्र', 'भ्य',
  'म्ब', 'म्भ', 'म्म', 'म्र', 'म्य', 'य्य', 'ल्ल', 'ल्य', 'व्य', 'व्र', 'श्च', 'श्न', 'श्य', 'श्ल', 'श्व', 'ष्ट', 'ष्ठ', 'ष्ण', 'ष्प', 'ष्म',
  'ष्य', 'स्त', 'स्थ', 'स्न', 'स्प', 'स्फ', 'स्म', 'स्य', 'स्र', 'स्व', 'स्क', 'क्त्र', 'स्त्र', 'न्त्र',
].filter((k) => codepoints(k).length >= 3);

export function devanagariKeys(): string[] {
  const vowels = range(0x0904, 0x0914);
  const signs = ['ँ', 'ं', 'ः', '़', 'ऽ'];
  const matras = range(0x093e, 0x094c);
  const nukta = range(0x0958, 0x095f);
  const misc = ['्', 'ॐ', '।', '॥', ...range(0x0966, 0x096f)];
  const halfForms = DEVANAGARI_CONSONANTS.filter((c) => c !== 'ह' && c !== 'र').map((c) => c + '्‍');
  const special = ['र्', '्र'];
  return [...vowels, ...DEVANAGARI_CONSONANTS, ...matras, ...signs, ...nukta, ...misc, ...halfForms, ...special, ...COMMON_CONJUNCTS];
}

export const PRESETS: Preset[] = [
  { id: 'latin-basic', name: 'Basic Latin letters', group: 'Latin', description: 'A to Z, upper and lower case', keys: () => [...range(0x41, 0x5a), ...range(0x61, 0x7a)] },
  { id: 'digits', name: 'Digits', group: 'Symbols', description: '0 to 9', keys: () => range(0x30, 0x39) },
  {
    id: 'punctuation',
    name: 'Punctuation',
    group: 'Symbols',
    description: 'Everyday and typographic punctuation',
    keys: () => [...chars('.,:;!?\'"()[]{}-_/\\&@#*%'), ...chars('‘’“”–—…•·¡¿«»‹›')],
  },
  { id: 'latin-1', name: 'Latin-1 letters', group: 'Latin', description: 'Western European accented letters', keys: () => range(0xc0, 0xff, (c) => c !== 0xd7 && c !== 0xf7 && isGraphic(c)) },
  { id: 'latin-ext-a', name: 'Latin Extended-A', group: 'Latin', description: 'Central European and more', keys: () => range(0x100, 0x17f) },
  { id: 'latin-ext-b', name: 'Latin Extended-B', group: 'Latin', description: 'Romanian, African and phonetic letters', keys: () => range(0x180, 0x24f) },
  { id: 'vietnamese', name: 'Vietnamese', group: 'Latin', description: 'All tone and vowel combinations', keys: vietnameseKeys },
  { id: 'accents', name: 'Combining accents', group: 'Latin', description: 'Marks used to build accented letters automatically', keys: () => chars('̧̨̛̣̀́̂̃̄̆̇̈̉̊̋̌') },
  { id: 'greek', name: 'Greek', group: 'Other scripts', description: 'Modern Greek with tonos', keys: () => range(0x386, 0x3ce, (c) => /^\p{L}$/u.test(String.fromCodePoint(c))) },
  { id: 'cyrillic', name: 'Cyrillic', group: 'Other scripts', description: 'Russian, Ukrainian, Serbian, Bulgarian and more', keys: () => [...range(0x400, 0x45f), 'Ґ', 'ґ'] },
  { id: 'currency', name: 'Currency', group: 'Symbols', description: 'Common currency signs', keys: () => chars('$¢£¥€₹₽₩₪₫₺₴₦₱₿') },
  { id: 'symbols', name: 'Symbols', group: 'Symbols', description: 'Maths, arrows and marks', keys: () => chars('+−×÷=<>±~^|°©®™§¶†‡‰←→↑↓✓') },
  { id: 'hiragana', name: 'Hiragana', group: 'Japanese', description: 'All hiragana including small forms', keys: () => [...range(0x3041, 0x3096), 'ゝ', 'ゞ', 'ー', '、', '。'] },
  { id: 'katakana', name: 'Katakana', group: 'Japanese', description: 'All katakana including small forms', keys: () => [...range(0x30a1, 0x30fa), 'ー', '・'] },
  { id: 'devanagari', name: 'Devanagari', group: 'Indic', description: 'Letters, vowel signs, half forms and 100 common conjuncts', keys: devanagariKeys },
];

/** Parse a pasted custom list. Separators: whitespace or commas. Runs without separators split by grapheme cluster. */
export function parseCustomList(text: string): string[] {
  const out: string[] = [];
  const seg = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  for (const tokenRaw of text.split(/[\s,]+/u)) {
    const token = tokenRaw.normalize('NFC');
    if (!token) continue;
    // U+XXXX notation
    const m = /^(?:U\+|u\+|\\u)([0-9a-fA-F]{4,6})$/.exec(token);
    if (m) {
      const cp = parseInt(m[1]!, 16);
      if (cp <= 0x10ffff) out.push(String.fromCodePoint(cp));
      continue;
    }
    if (seg) for (const s of seg.segment(token)) out.push(s.segment);
    else out.push(...Array.from(token));
  }
  return dedupeKeys(out.filter((k) => codepoints(k).some((c) => isGraphic(c))));
}

export function dedupeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    const n = k.normalize('NFC');
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** Base key for a precomposed character plus its combining marks, if it decomposes canonically. */
export function decomposition(key: string): { base: string; marks: string[] } | null {
  if (!isSingle(key)) return null;
  const d = codepoints(key.normalize('NFD'));
  if (d.length < 2) return null;
  const base = d[0]!;
  const marks = d.slice(1);
  if (isMark(base) || !marks.every((m) => isNonSpacingMark(m))) return null;
  return { base: String.fromCodePoint(base), marks: marks.map((m) => String.fromCodePoint(m)) };
}

/**
 * Keys that must be written to cover `keys` when accented letters are composed
 * automatically from bases and marks.
 */
export function keysToWrite(keys: string[], autoCompose: boolean): { write: string[]; composed: string[] } {
  if (!autoCompose) return { write: keys, composed: [] };
  const set = new Set(keys);
  const write: string[] = [];
  const composed: string[] = [];
  const extra = new Set<string>();
  for (const k of keys) {
    const d = decomposition(k);
    // Vietnamese and Latin letters compose well; Devanagari nukta forms stay written.
    if (d && scriptOf(codepoints(k)[0]!) !== 'devanagari') {
      composed.push(k);
      if (!set.has(d.base)) extra.add(d.base);
      for (const m of d.marks) if (!set.has(m)) extra.add(m);
    } else write.push(k);
  }
  // Some bases are themselves composable (e.g. ấ -> â + ́ -> a + ̂ + ́); NFD already fully decomposes.
  return { write: dedupeKeys([...write, ...extra]), composed };
}
