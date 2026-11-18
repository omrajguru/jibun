/** Growable big-endian binary writer used by every table compiler. */
export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number) {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  get length() {
    return this.pos;
  }

  u8(v: number) {
    checkRange(v, 0, 0xff, 'u8');
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }
  i8(v: number) {
    checkRange(v, -0x80, 0x7f, 'i8');
    this.ensure(1);
    this.view.setInt8(this.pos, v);
    this.pos += 1;
    return this;
  }
  u16(v: number) {
    checkRange(v, 0, 0xffff, 'u16');
    this.ensure(2);
    this.view.setUint16(this.pos, v);
    this.pos += 2;
    return this;
  }
  i16(v: number) {
    checkRange(v, -0x8000, 0x7fff, 'i16');
    this.ensure(2);
    this.view.setInt16(this.pos, v);
    this.pos += 2;
    return this;
  }
  u24(v: number) {
    checkRange(v, 0, 0xffffff, 'u24');
    this.u8((v >>> 16) & 0xff);
    this.u16(v & 0xffff);
    return this;
  }
  u32(v: number) {
    checkRange(v, 0, 0xffffffff, 'u32');
    this.ensure(4);
    this.view.setUint32(this.pos, v);
    this.pos += 4;
    return this;
  }
  i32(v: number) {
    checkRange(v, -0x80000000, 0x7fffffff, 'i32');
    this.ensure(4);
    this.view.setInt32(this.pos, v);
    this.pos += 4;
    return this;
  }
  /** 16.16 fixed */
  fixed(v: number) {
    return this.i32(Math.round(v * 65536));
  }
  /** LONGDATETIME: seconds since 1904-01-01 as 64-bit */
  longDateTime(date: Date) {
    const secs = Math.floor(date.getTime() / 1000) + 2082844800;
    this.u32(Math.floor(secs / 0x100000000));
    this.u32(secs >>> 0);
    return this;
  }
  tag(t: string) {
    if (t.length !== 4) throw new Error(`bad tag ${t}`);
    for (let i = 0; i < 4; i++) this.u8(t.charCodeAt(i));
    return this;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }
  zeros(n: number) {
    this.ensure(n);
    this.buf.fill(0, this.pos, this.pos + n);
    this.pos += n;
    return this;
  }
  pad4() {
    while (this.pos % 4) this.u8(0);
    return this;
  }
  /** Overwrite a u16 at an earlier position. */
  setU16(at: number, v: number) {
    checkRange(v, 0, 0xffff, 'u16 (patch)');
    this.view.setUint16(at, v);
  }
  setU32(at: number, v: number) {
    checkRange(v, 0, 0xffffffff, 'u32 (patch)');
    this.view.setUint32(at, v);
  }
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

function checkRange(v: number, min: number, max: number, what: string) {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`value ${v} out of range for ${what}`);
  }
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function tableChecksum(data: Uint8Array): number {
  let sum = 0;
  const n = data.length;
  for (let i = 0; i < n; i += 4) {
    const v =
      ((data[i] ?? 0) << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0);
    sum = (sum + (v >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

/** Build a table from sub-blocks addressed by 16-bit offsets, verifying each offset fits. */
export function off16(v: number, ctx: string): number {
  if (v > 0xffff) throw new RangeError(`16-bit offset overflow in ${ctx} (${v})`);
  return v;
}
