/**
 * Outline geometry: contours made of line and cubic segments, SVG path parsing and
 * serialisation, affine transforms, bounding boxes, winding normalisation and
 * cubic-to-quadratic conversion for TrueType.
 */
export interface Pt {
  x: number;
  y: number;
}
export type Seg = { t: 'L'; p: Pt } | { t: 'C'; c1: Pt; c2: Pt; p: Pt };
export interface Contour {
  start: Pt;
  segs: Seg[];
}
export type Outline = Contour[];

export interface BBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

// ---------------------------------------------------------------- SVG parsing

const CMD_RE = /[MmLlHhVvCcSsQqTtZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

export function parseSvgPath(d: string): Outline {
  const tokens = d.match(CMD_RE) ?? [];
  const out: Outline = [];
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastC2: Pt | null = null; // for S
  let lastQ: Pt | null = null; // for T
  let cur: Contour | null = null;
  const isCmd = (t: string | undefined) => t !== undefined && /^[A-Za-z]$/.test(t);
  const num = (): number => {
    const t = tokens[i++];
    if (t === undefined || isCmd(t)) throw new Error('malformed path data');
    return parseFloat(t);
  };
  const close = () => {
    if (cur && cur.segs.length) out.push(cur);
    cur = null;
  };
  const ensure = () => {
    if (!cur) cur = { start: { x: cx, y: cy }, segs: [] };
    return cur;
  };
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++]!;
    else if (!cmd) throw new Error('path data must start with a command');
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    switch (C) {
      case 'M': {
        close();
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        cx = sx = x;
        cy = sy = y;
        cur = { start: { x, y }, segs: [] };
        cmd = rel ? 'l' : 'L'; // implicit lineto after moveto
        lastC2 = lastQ = null;
        break;
      }
      case 'L': {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        ensure().segs.push({ t: 'L', p: { x, y } });
        cx = x;
        cy = y;
        lastC2 = lastQ = null;
        break;
      }
      case 'H': {
        const x = num() + (rel ? cx : 0);
        ensure().segs.push({ t: 'L', p: { x, y: cy } });
        cx = x;
        lastC2 = lastQ = null;
        break;
      }
      case 'V': {
        const y = num() + (rel ? cy : 0);
        ensure().segs.push({ t: 'L', p: { x: cx, y } });
        cy = y;
        lastC2 = lastQ = null;
        break;
      }
      case 'C': {
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        const c1 = { x: num() + ox, y: num() + oy };
        const c2 = { x: num() + ox, y: num() + oy };
        const p = { x: num() + ox, y: num() + oy };
        ensure().segs.push({ t: 'C', c1, c2, p });
        cx = p.x;
        cy = p.y;
        lastC2 = c2;
        lastQ = null;
        break;
      }
      case 'S': {
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        const c1 = lastC2 ? { x: 2 * cx - lastC2.x, y: 2 * cy - lastC2.y } : { x: cx, y: cy };
        const c2 = { x: num() + ox, y: num() + oy };
        const p = { x: num() + ox, y: num() + oy };
        ensure().segs.push({ t: 'C', c1, c2, p });
        cx = p.x;
        cy = p.y;
        lastC2 = c2;
        lastQ = null;
        break;
      }
      case 'Q': {
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        const q = { x: num() + ox, y: num() + oy };
        const p = { x: num() + ox, y: num() + oy };
        ensure().segs.push(quadToCubic({ x: cx, y: cy }, q, p));
        cx = p.x;
        cy = p.y;
        lastQ = q;
        lastC2 = null;
        break;
      }
      case 'T': {
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        const q: Pt = lastQ ? { x: 2 * cx - lastQ.x, y: 2 * cy - lastQ.y } : { x: cx, y: cy };
        const p = { x: num() + ox, y: num() + oy };
        ensure().segs.push(quadToCubic({ x: cx, y: cy }, q, p));
        cx = p.x;
        cy = p.y;
        lastQ = q;
        lastC2 = null;
        break;
      }
      case 'Z': {
        close();
        cx = sx;
        cy = sy;
        lastC2 = lastQ = null;
        // Repeated Z or a following command without M continues from the start point.
        break;
      }
      default:
        throw new Error(`unsupported path command ${cmd}`);
    }
  }
  close();
  return out.map(dropClosingSegment).filter((c) => c.segs.length > 0);
}

function quadToCubic(p0: Pt, q: Pt, p: Pt): Seg {
  return {
    t: 'C',
    c1: { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) },
    c2: { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) },
    p,
  };
}

/** A trailing line back to the start point is implied by closing; remove it. */
function dropClosingSegment(c: Contour): Contour {
  const segs = c.segs.slice();
  const last = segs[segs.length - 1];
  if (last && last.t === 'L' && near(last.p, c.start)) segs.pop();
  // Remove zero-length line segments.
  const cleaned: Seg[] = [];
  let prev = c.start;
  for (const s of segs) {
    if (s.t === 'L' && near(s.p, prev)) continue;
    cleaned.push(s);
    prev = s.p;
  }
  return { start: c.start, segs: cleaned };
}

function near(a: Pt, b: Pt, eps = 1e-9) {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

export function outlineToSvgPath(o: Outline, digits = 1): string {
  const f = (n: number) => {
    const r = Number(n.toFixed(digits));
    return Object.is(r, -0) ? '0' : String(r);
  };
  const parts: string[] = [];
  for (const c of o) {
    parts.push(`M${f(c.start.x)} ${f(c.start.y)}`);
    for (const s of c.segs) {
      if (s.t === 'L') parts.push(`L${f(s.p.x)} ${f(s.p.y)}`);
      else parts.push(`C${f(s.c1.x)} ${f(s.c1.y)} ${f(s.c2.x)} ${f(s.c2.y)} ${f(s.p.x)} ${f(s.p.y)}`);
    }
    parts.push('Z');
  }
  return parts.join('');
}

// ---------------------------------------------------------------- transforms

/** Affine [a b c d e f]: x' = a*x + c*y + e, y' = b*x + d*y + f */
export type Affine = [number, number, number, number, number, number];

export function transformOutline(o: Outline, m: Affine): Outline {
  const tp = (p: Pt): Pt => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
  return o.map((c) => ({
    start: tp(c.start),
    segs: c.segs.map((s) => (s.t === 'L' ? { t: 'L', p: tp(s.p) } : { t: 'C', c1: tp(s.c1), c2: tp(s.c2), p: tp(s.p) })),
  }));
}

export function translate(o: Outline, dx: number, dy: number): Outline {
  return transformOutline(o, [1, 0, 0, 1, dx, dy]);
}

export function scaleAbout(o: Outline, s: number, ox: number, oy: number): Outline {
  return transformOutline(o, [s, 0, 0, s, ox - s * ox, oy - s * oy]);
}

// ---------------------------------------------------------------- measurement

export function emptyBBox(): BBox {
  return { xMin: Infinity, yMin: Infinity, xMax: -Infinity, yMax: -Infinity };
}

export function isEmptyBBox(b: BBox) {
  return !(b.xMax >= b.xMin);
}

function addPt(b: BBox, p: Pt) {
  if (p.x < b.xMin) b.xMin = p.x;
  if (p.x > b.xMax) b.xMax = p.x;
  if (p.y < b.yMin) b.yMin = p.y;
  if (p.y > b.yMax) b.yMax = p.y;
}

/** Exact bbox, accounting for cubic extrema. */
export function outlineBBox(o: Outline): BBox {
  const b = emptyBBox();
  for (const c of o) {
    let prev = c.start;
    addPt(b, prev);
    for (const s of c.segs) {
      if (s.t === 'L') addPt(b, s.p);
      else {
        addPt(b, s.p);
        for (const t of cubicExtrema(prev.x, s.c1.x, s.c2.x, s.p.x)) addPt(b, cubicAt(prev, s, t));
        for (const t of cubicExtrema(prev.y, s.c1.y, s.c2.y, s.p.y)) addPt(b, cubicAt(prev, s, t));
      }
      prev = s.p;
    }
  }
  return b;
}

function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // derivative: 3[(p1-p0)(1-t)^2 + 2(p2-p1)t(1-t) + (p3-p2)t^2]
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      ts.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

export function cubicAt(p0: Pt, s: { c1: Pt; c2: Pt; p: Pt }, t: number): Pt {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * s.c1.x + c * s.c2.x + d * s.p.x,
    y: a * p0.y + b * s.c1.y + c * s.c2.y + d * s.p.y,
  };
}

/** Flatten a contour into a polygon (for area, containment and profiles). */
export function flatten(c: Contour, steps = 8): Pt[] {
  const pts: Pt[] = [c.start];
  let prev = c.start;
  for (const s of c.segs) {
    if (s.t === 'L') pts.push(s.p);
    else for (let k = 1; k <= steps; k++) pts.push(cubicAt(prev, s, k / steps));
    prev = s.p;
  }
  return pts;
}

export function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j]!.x * pts[i]!.y - pts[i]!.x * pts[j]!.y);
  return a / 2; // positive = counter-clockwise in y-up space
}

function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function reverseContour(c: Contour): Contour {
  // Collect the node list then walk it backwards.
  const nodes: Pt[] = [c.start, ...c.segs.map((s) => s.p)];
  const segs: Seg[] = [];
  const n = c.segs.length;
  // Contour is closed: start == implicit end. Reversed contour starts at start.
  // Segment k goes from nodes[k] to nodes[k+1] (nodes[n] is last explicit point, closing returns to start).
  // Build reversed: from start back along closing edge to nodes[n], ...
  const closingIsLine = true;
  const out: Seg[] = [];
  if (closingIsLine && !near(nodes[n]!, c.start)) out.push({ t: 'L', p: nodes[n]! });
  for (let k = n - 1; k >= 0; k--) {
    const s = c.segs[k]!;
    const to = nodes[k]!;
    if (s.t === 'L') out.push({ t: 'L', p: to });
    else out.push({ t: 'C', c1: s.c2, c2: s.c1, p: to });
  }
  // The final segment lands on start; drop it if it's a line (implicit close).
  const last = out[out.length - 1];
  if (last && last.t === 'L' && near(last.p, c.start)) out.pop();
  segs.push(...out);
  return { start: c.start, segs };
}

/**
 * Normalise winding so outer contours run in `outerDir` and holes the opposite way.
 * TrueType wants clockwise outers (y-up), CFF counter-clockwise.
 */
export function normaliseWinding(o: Outline, outerDir: 'cw' | 'ccw'): Outline {
  const polys = o.map((c) => flatten(c, 6));
  const areas = polys.map(polygonArea);
  return o
    .map((c, i) => {
      if (Math.abs(areas[i]!) < 1e-6) return null;
      // depth = number of other contours containing a point of this contour
      const probe = polys[i]![0]!;
      let depth = 0;
      for (let j = 0; j < o.length; j++) if (j !== i && Math.abs(areas[j]!) > Math.abs(areas[i]!) && pointInPolygon(probe, polys[j]!)) depth++;
      const wantCCW = (depth % 2 === 0) === (outerDir === 'ccw');
      const isCCW = areas[i]! > 0;
      return isCCW === wantCCW ? c : reverseContour(c);
    })
    .filter((c): c is Contour => c !== null);
}

// ---------------------------------------------------------------- quadratic conversion

export interface QuadPoint {
  x: number;
  y: number;
  on: boolean;
}

/** Convert a contour to TrueType points (on/off curve), approximating cubics within `tol` units. */
export function contourToQuadPoints(c: Contour, tol = 0.5): QuadPoint[] {
  const pts: QuadPoint[] = [{ x: c.start.x, y: c.start.y, on: true }];
  let prev = c.start;
  for (const s of c.segs) {
    if (s.t === 'L') pts.push({ x: s.p.x, y: s.p.y, on: true });
    else {
      for (const q of cubicToQuads(prev, s.c1, s.c2, s.p, tol)) {
        pts.push({ x: q.c.x, y: q.c.y, on: false });
        pts.push({ x: q.p.x, y: q.p.y, on: true });
      }
    }
    prev = s.p;
  }
  // Closing point equals start for curves ending at start: remove duplicate last on-curve point.
  const last = pts[pts.length - 1]!;
  if (pts.length > 1 && last.on && near(last, c.start, 1e-9)) pts.pop();
  return pts;
}

function cubicToQuads(p0: Pt, c1: Pt, c2: Pt, p3: Pt, tol: number, depth = 0): { c: Pt; p: Pt }[] {
  // Candidate single quadratic control point.
  const q = { x: (3 * (c1.x + c2.x) - p0.x - p3.x) / 4, y: (3 * (c1.y + c2.y) - p0.y - p3.y) / 4 };
  // Error bound of approximating cubic by that quad: sqrt(3)/36 * |p3 - 3c2 + 3c1 - p0|
  const ex = p3.x - 3 * c2.x + 3 * c1.x - p0.x;
  const ey = p3.y - 3 * c2.y + 3 * c1.y - p0.y;
  const err = (Math.sqrt(3) / 36) * Math.hypot(ex, ey);
  if (err <= tol || depth >= 8) return [{ c: q, p: p3 }];
  // Split at t=0.5 (de Casteljau)
  const m01 = mid(p0, c1);
  const m12 = mid(c1, c2);
  const m23 = mid(c2, p3);
  const a = mid(m01, m12);
  const b = mid(m12, m23);
  const m = mid(a, b);
  return [...cubicToQuads(p0, m01, a, m, tol, depth + 1), ...cubicToQuads(m, b, m23, p3, tol, depth + 1)];
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
