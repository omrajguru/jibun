/**
 * WOFF2 encoder using null transforms for every table (glyf/loca use transform
 * version 3), which is valid per the WOFF2 specification and supported by every
 * major decoder. Brotli is injected so the module stays runtime-agnostic.
 */
import { Writer, concat } from './binary';

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

export type BrotliCompress = (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;

function base128(w: Writer, v: number) {
  const bytes: number[] = [];
  do {
    bytes.unshift(v & 0x7f);
    v = Math.floor(v / 128);
  } while (v > 0);
  for (let i = 0; i < bytes.length; i++) w.u8(bytes[i]! | (i < bytes.length - 1 ? 0x80 : 0));
}

interface SfntTable {
  tag: string;
  data: Uint8Array;
}

export function readSfntTables(font: Uint8Array): { flavor: number; tables: SfntTable[] } {
  const dv = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const flavor = dv.getUint32(0);
  const n = dv.getUint16(4);
  const tables: SfntTable[] = [];
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const tag = String.fromCharCode(font[r]!, font[r + 1]!, font[r + 2]!, font[r + 3]!);
    const off = dv.getUint32(r + 8);
    const len = dv.getUint32(r + 12);
    tables.push({ tag, data: font.subarray(off, off + len) });
  }
  return { flavor, tables };
}

export async function encodeWOFF2(font: Uint8Array, brotli: BrotliCompress): Promise<Uint8Array> {
  const { flavor, tables } = readSfntTables(font);
  // glyf must precede loca; sorted tag order guarantees it.
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const dir = new Writer(tables.length * 8);
  let totalSfntSize = 12 + 16 * tables.length;
  for (const t of tables) {
    const known = KNOWN_TAGS.indexOf(t.tag);
    let flags = known >= 0 ? known : 63;
    if (t.tag === 'glyf' || t.tag === 'loca') flags |= 0xc0; // transform version 3 = null
    dir.u8(flags);
    if (known < 0) dir.tag(t.tag);
    base128(dir, t.data.length);
    totalSfntSize += (t.data.length + 3) & ~3;
  }
  const stream = concat(tables.map((t) => t.data));
  const compressed = await brotli(stream);
  const dirBytes = dir.toBytes();
  const headerLen = 48;
  const unpadded = headerLen + dirBytes.length + compressed.length;
  const length = (unpadded + 3) & ~3;
  const h = new Writer(headerLen);
  h.tag('wOF2').u32(flavor).u32(length).u16(tables.length).u16(0);
  h.u32(totalSfntSize).u32(compressed.length);
  h.u16(1).u16(0);
  h.u32(0).u32(0).u32(0).u32(0).u32(0);
  const out = new Uint8Array(length);
  out.set(h.toBytes(), 0);
  out.set(dirBytes, headerLen);
  out.set(compressed, headerLen + dirBytes.length);
  return out;
}
