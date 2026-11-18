/** Synthetic glyph outlines in cell units (x 0..1100, y -300..950, baseline 0). */
const K = 0.5522847498;

export function rect(x0: number, y0: number, x1: number, y1: number, ccw = true): string {
  return ccw ? `M${x0} ${y0}L${x1} ${y0}L${x1} ${y1}L${x0} ${y1}Z` : `M${x0} ${y0}L${x0} ${y1}L${x1} ${y1}L${x1} ${y0}Z`;
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, ccw = true): string {
  const kx = rx * K;
  const ky = ry * K;
  if (ccw)
    return `M${cx + rx} ${cy}C${cx + rx} ${cy + ky} ${cx + kx} ${cy + ry} ${cx} ${cy + ry}C${cx - kx} ${cy + ry} ${cx - rx} ${cy + ky} ${cx - rx} ${cy}C${cx - rx} ${cy - ky} ${cx - kx} ${cy - ry} ${cx} ${cy - ry}C${cx + kx} ${cy - ry} ${cx + rx} ${cy - ky} ${cx + rx} ${cy}Z`;
  return `M${cx + rx} ${cy}C${cx + rx} ${cy - ky} ${cx + kx} ${cy - ry} ${cx} ${cy - ry}C${cx - kx} ${cy - ry} ${cx - rx} ${cy - ky} ${cx - rx} ${cy}C${cx - rx} ${cy + ky} ${cx - kx} ${cy + ry} ${cx} ${cy + ry}C${cx + kx} ${cy + ry} ${cx + rx} ${cy + ky} ${cx + rx} ${cy}Z`;
}

export function ring(cx: number, cy: number, rx: number, ry: number, t: number): string {
  return ellipse(cx, cy, rx, ry, true) + ellipse(cx, cy, rx - t, ry - t, false);
}

/** A plausible stand-in outline for a character (different shapes so kerning has something to do). */
export function glyphFor(ch: string, jitter = 0): string {
  const j = jitter * 17;
  switch (ch) {
    case 'T':
      return rect(300 + j, 620, 800 + j, 700) + rect(510 + j, 0, 590 + j, 620);
    case 'o':
      return ring(550 + j, 250, 220, 250, 70);
    case 'O':
      return ring(550 + j, 350, 300, 350, 80);
    case 'A':
      return `M${300 + j} 0L${380 + j} 0L${550 + j} 600L${720 + j} 0L${800 + j} 0L${590 + j} 700L${510 + j} 700Z` + rect(400 + j, 220, 700 + j, 280);
    case 'V':
      return `M${300 + j} 700L${380 + j} 700L${550 + j} 100L${720 + j} 700L${800 + j} 700L${590 + j} 0L${510 + j} 0Z`;
    case 'i':
      return rect(510 + j, 0, 590 + j, 500) + ellipse(550 + j, 640, 50, 50);
    case 'l':
      return rect(510 + j, 0, 590 + j, 800);
    case '.':
      return ellipse(550 + j, 45, 45, 45);
    case '\u0301':
      return `M${560} 560L${620} 560L${700} 700L${640} 700Z`; // acute above the reference circle (top 500)
    case '\u0302':
      return `M470 560L550 680L630 560L600 560L550 640L500 560Z`;
    case '\u0323':
      return ellipse(550, -90, 40, 40); // dot below
    default: {
      // generic: stem + bowl, varied by code point
      const cp = ch.codePointAt(0)!;
      const w = 160 + (cp % 7) * 30;
      return rect(400 + j, 0, 470 + j, 500 + (cp % 3) * 150) + ring(470 + w / 2 + j, 250, w / 2 + 20, 240, 60);
    }
  }
}
