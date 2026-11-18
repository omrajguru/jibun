import type { Paper } from './layout';

export interface FontSettings {
  familyName: string;
  /** base sidebearing on each side, font units */
  sidebearing: number;
  /** extra spacing added to every glyph on each side */
  tracking: number;
  baselineShift: number;
  /** 1 = as written */
  scale: number;
  spaceWidth: number;
  lineGap: number;
  kerning: boolean;
  kerningStrength: number;
  alternates: boolean;
  autoCompose: boolean;
}

export const DEFAULT_SETTINGS: FontSettings = {
  familyName: 'My Handwriting',
  sidebearing: 45,
  tracking: 0,
  baselineShift: 0,
  scale: 1,
  spaceWidth: 300,
  lineGap: 200,
  kerning: true,
  kerningStrength: 1,
  alternates: true,
  autoCompose: true,
};

export interface GlyphAdjust {
  /** extra units on the left / right side */
  lsb?: number;
  rsb?: number;
  baseline?: number;
  scale?: number;
}

export interface LigatureDef {
  id: string;
  /** the text that is replaced, e.g. "th" */
  sequence: string;
  /** units the components overlap by */
  overlap: number;
}

export interface SampleForBuild {
  key: string;
  /** SVG path in cell font units (y up) */
  path: string;
}

export interface BuildInput {
  settings: FontSettings;
  characters: { key: string; adjust?: GlyphAdjust | null }[];
  /** ordered: first sample of a key is the default glyph, the rest become alternates */
  samples: SampleForBuild[];
  ligatures: LigatureDef[];
  /** optional subset (keys) used for WOFF2 subsetting */
  subset?: string[] | null;
}

export type SampleFlag = 'empty' | 'edge' | 'noise' | 'faint' | 'tiny' | 'unaligned';

export interface ProjectSummary {
  id: string;
  name: string;
  paper: Paper;
  samplesPerChar: number;
  characterCount: number;
  capturedCount: number;
  flaggedCount: number;
  createdAt: number;
  updatedAt: number;
  lastBuild?: BuildSummary | null;
}

export interface CharacterRow {
  key: string;
  position: number;
  adjust: GlyphAdjust | null;
}

export interface SampleRow {
  id: string;
  key: string;
  pageId: string | null;
  cellIndex: number | null;
  path: string;
  flags: SampleFlag[];
  confidence: number;
  status: 'ok' | 'flagged' | 'rejected';
  source: 'scan' | 'screen';
  createdAt: number;
  bitmapKey: string | null;
}

export interface PageRow {
  id: string;
  projectId: string;
  kind: 'template' | 'rewrite';
  paper: Paper;
  pageNumber: number;
  pageCount: number;
  cells: string[];
  createdAt: number;
  processedAt: number | null;
}

export type BuildStatus = 'queued' | 'running' | 'done' | 'failed';

export interface BuildSummary {
  id: string;
  projectId: string;
  status: BuildStatus;
  formats: ExportFormat[];
  glyphCount: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  files: { format: ExportFormat; size: number }[];
  progress?: number;
}

export type ExportFormat = 'ttf' | 'otf' | 'woff2';

export interface ProjectDetail {
  project: ProjectSummary & { settings: FontSettings };
  characters: CharacterRow[];
  samples: SampleRow[];
  pages: PageRow[];
  ligatures: LigatureDef[];
}

/** Payload sent from the browser for each processed cell. */
export interface SampleUpload {
  key: string;
  cellIndex: number | null;
  path: string;
  flags: SampleFlag[];
  confidence: number;
  /** PNG of the trimmed bitmap, base64 (no data: prefix) */
  bitmap: string | null;
  source: 'scan' | 'screen';
}

export const LIMITS = {
  maxCharacters: 5000,
  maxGlyphs: 65535,
  maxSamplesPerChar: 4,
  maxPathLength: 60_000,
  maxBitmapBytes: 64_000,
  maxSamplesPerRequest: 200,
  maxScanBytes: 25_000_000,
  maxLigatures: 500,
} as const;
