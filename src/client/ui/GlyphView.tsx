import { memo } from 'react';
import { BOX_BOTTOM_UNITS, BOX_TOP_UNITS, BOX_W_UNITS, METRICS } from '../../shared/layout';

/** Renders a captured outline (cell units, y up) inside a cell-shaped frame. */
export const GlyphView = memo(function GlyphView({ path, guides = false, color = 'currentColor' }: { path: string; guides?: boolean; color?: string }) {
  const h = BOX_TOP_UNITS - BOX_BOTTOM_UNITS;
  return (
    <svg viewBox={`0 ${-BOX_TOP_UNITS} ${BOX_W_UNITS} ${h}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      {guides ? (
        <g stroke="var(--blue-100)" strokeWidth={8}>
          <line x1={0} x2={BOX_W_UNITS} y1={0} y2={0} />
          <line x1={0} x2={BOX_W_UNITS} y1={-METRICS.xHeight} y2={-METRICS.xHeight} />
          <line x1={0} x2={BOX_W_UNITS} y1={-METRICS.capHeight} y2={-METRICS.capHeight} />
        </g>
      ) : null}
      <path d={path} transform="scale(1,-1)" fill={color} />
    </svg>
  );
});
