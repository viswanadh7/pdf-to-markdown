import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfToMarkdownOptions {
  /** Separate pages with `---` instead of joining content that flows across pages. */
  pageBreaks?: boolean;
  /** Keep running headers, footers and page numbers (removed by default). */
  keepHeadersFooters?: boolean;
}

/** A positioned, styled piece of text as reported by pdf.js. */
interface Glyph {
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  link?: string;
}

/** A styled stretch of text inside a line. */
interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  link?: string;
}

/** Glyphs on one baseline with no large horizontal gap between them. */
interface Segment {
  x0: number;
  x1: number;
  glyphs: Glyph[];
  runs: Run[];
  text: string;
}

interface Line {
  y: number;
  x0: number;
  x1: number;
  size: number;
  bold: boolean;
  mono: boolean;
  segments: Segment[];
  runs: Run[];
  text: string;
}

interface Page {
  lines: Line[];
  top: number;
  bottom: number;
  height: number;
}

type Region =
  | { kind: "text"; lines: Line[]; flow: Line[] }
  | { kind: "table"; block: TableBlock };

interface TableBlock {
  kind: "table";
  rows: string[][];
  anchors: number[];
}

type Block =
  | { kind: "heading"; level: number; text: string; lines: number }
  | { kind: "paragraph"; runs: Run[]; size: number }
  | {
      kind: "item";
      runs: Run[];
      size: number;
      depth: number;
      marker: string | null;
    }
  | { kind: "code"; lines: { x0: number; text: string }[]; size: number }
  | TableBlock;

interface Stats {
  lineGap(size: number): number;
  headingLevel(line: Line): number;
}

const BOLD_RE = /bold|black|heavy|semibold|demibold|extrabold/i;
const ITALIC_RE = /italic|oblique/i;
const MONO_RE = /mono|courier|consol|menlo|inconsolata|code/i;

const STRONG_BULLET_RE = /^[•●○◦‣⁃▪■□◆◇►▸▹➢➤✓✔\uf0b7\uf0a7]\s*(?=\S)/;
const WEAK_BULLET_RE = /^[-–*]\s+(?=\S)/;
const NUMBERED_RE = /^(\d{1,3})[.)]\s+(?=\S)/;
const PAGE_NUMBER_RE = /^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i;
// Lines of structured data (JSON and similar) set in a proportional font.
const DATA_LINE_RE = /^([{}[\]][\]}),;]*|"[^"]*"\s*:.*)$/;
const SENTENCE_END_RE = /[.!?:;]["”’)\]]?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export async function pdfToMarkdown(
  data: Uint8Array | ArrayBuffer | Buffer,
  options: PdfToMarkdownOptions = {},
): Promise<string> {
  const bytes = toPlainUint8Array(data);

  const doc = await pdfjsLib.getDocument({ data: bytes, verbosity: 0 })
    .promise;

  const pages: Page[] = [];
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      pages.push(await extractPage(page));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }

  if (!options.keepHeadersFooters) removeRunningHeadersAndFooters(pages);

  const pageFlows = pages.map((page) => readingOrder(page).map(splitTables));
  const stats = computeStats(pageFlows.flat());

  const pageBlocks = pageFlows.map((flows) => {
    const blocks: Block[] = [];
    for (const regions of flows) {
      appendBlocks(
        blocks,
        regions.flatMap((r) =>
          r.kind === "table" ? [r.block] : textToBlocks(r, stats),
        ),
      );
    }
    return blocks;
  });

  let markdown: string;
  if (options.pageBreaks) {
    markdown = pageBlocks
      .map(renderBlocks)
      .filter((p) => p.length > 0)
      .join("\n\n---\n\n");
  } else {
    const all: Block[] = [];
    for (const blocks of pageBlocks) appendBlocks(all, blocks);
    markdown = renderBlocks(all);
  }
  return markdown.trim() + "\n";
}

function toPlainUint8Array(
  data: Uint8Array | ArrayBuffer | Buffer,
): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // pdf.js rejects Buffer subclasses, so re-wrap the same memory.
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

async function extractPage(page: pdfjsLib.PDFPageProxy): Promise<Page> {
  const [, viewBottom, , viewTop] = page.view;

  // Loading the operator list resolves the page's fonts into commonObjs,
  // which is the only place their real names (and so bold/italic) live.
  try {
    await page.getOperatorList();
  } catch {
    // Font styles fall back to the generic family below.
  }
  const content = await page.getTextContent();
  const fontStyle = fontStyleResolver(page, content.styles);
  const links = await linkAreas(page);

  const glyphs: Glyph[] = [];
  for (const raw of content.items) {
    if (!("str" in raw)) continue;
    const item = raw as PdfTextItem;
    // Unmapped glyphs (icons, symbol fonts) come through as control chars.
    const str = item.str.replace(CONTROL_CHARS_RE, "");
    if (!str.trim()) continue;
    const [a, b, c, d, x, y] = item.transform;
    // Skip rotated or mirrored text (watermarks, vertical labels).
    if (a <= 0 || Math.abs(b) > Math.abs(a) * 0.2) continue;
    const size = Math.hypot(c, d) || item.height;
    if (!size) continue;
    const glyph: Glyph = {
      str,
      x,
      y,
      width: item.width,
      size,
      ...fontStyle(item.fontName),
    };
    glyph.link = links.find((l) => covers(l.rect, glyph))?.url;
    glyphs.push(glyph);
  }

  return {
    lines: groupIntoLines(glyphs),
    top: viewTop,
    bottom: viewBottom,
    height: viewTop - viewBottom,
  };
}

function fontStyleResolver(
  page: pdfjsLib.PDFPageProxy,
  styles: Record<string, { fontFamily?: string }>,
) {
  const cache = new Map<string, Pick<Glyph, "bold" | "italic" | "mono">>();
  return (fontId: string) => {
    let style = cache.get(fontId);
    if (style) return style;
    let name = "";
    let bold = false;
    let italic = false;
    try {
      const font = page.commonObjs.get(fontId) as {
        name?: string;
        bold?: boolean;
        black?: boolean;
        italic?: boolean;
      } | null;
      name = font?.name ?? "";
      bold = Boolean(font?.bold || font?.black);
      italic = Boolean(font?.italic);
    } catch {
      // Font not resolved; rely on the family name only.
    }
    const family = styles[fontId]?.fontFamily ?? "";
    style = {
      bold: bold || BOLD_RE.test(name),
      italic: italic || ITALIC_RE.test(name),
      mono: family === "monospace" || MONO_RE.test(name),
    };
    cache.set(fontId, style);
    return style;
  };
}

async function linkAreas(
  page: pdfjsLib.PDFPageProxy,
): Promise<{ rect: number[]; url: string }[]> {
  try {
    const annotations = (await page.getAnnotations()) as {
      subtype?: string;
      url?: string;
      rect?: number[];
    }[];
    return annotations
      .filter((a) => a.subtype === "Link" && a.url && a.rect)
      .map((a) => ({ rect: a.rect!, url: a.url! }));
  } catch {
    return [];
  }
}

/** Whether most of the glyph sits inside the rectangle. */
function covers(rect: number[], g: Glyph): boolean {
  const [x0, y0, x1, y1] = rect;
  const midY = g.y + g.size * 0.3;
  if (midY < Math.min(y0, y1) - 1 || midY > Math.max(y0, y1) + 1) return false;
  const overlap =
    Math.min(g.x + g.width, Math.max(x0, x1)) - Math.max(g.x, Math.min(x0, x1));
  return overlap >= g.width * 0.6;
}

// ---------------------------------------------------------------------------
// Lines and segments
// ---------------------------------------------------------------------------

function groupIntoLines(glyphs: Glyph[]): Line[] {
  const sorted = [...glyphs].sort((a, b) => b.y - a.y);
  const clusters: Glyph[][] = [];
  let anchor: Glyph | null = null;
  for (const g of sorted) {
    if (
      anchor &&
      Math.abs(anchor.y - g.y) <= Math.max(anchor.size, g.size) * 0.45
    ) {
      clusters[clusters.length - 1].push(g);
    } else {
      clusters.push([g]);
      anchor = g;
    }
  }

  return clusters.map((cluster) => {
    cluster.sort((a, b) => a.x - b.x);
    const parts: Glyph[][] = [];
    let prev: Glyph | null = null;
    for (const g of cluster) {
      // Some generators fake bold by drawing the same text twice, offset.
      if (
        prev &&
        prev.str === g.str &&
        Math.abs(prev.x - g.x) < g.size * 0.5
      ) {
        prev.bold = true;
        continue;
      }
      const gap = prev ? g.x - (prev.x + prev.width) : 0;
      if (!prev || gap > Math.max(prev.size, g.size) * 1.5) parts.push([g]);
      else parts[parts.length - 1].push(g);
      prev = g;
    }
    const dominant = cluster.reduce((a, b) => (b.size > a.size ? b : a));
    return makeLine(dominant.y, parts.map(makeSegment));
  });
}

function makeSegment(glyphs: Glyph[]): Segment {
  const runs: Run[] = [];
  let prev: Glyph | null = null;
  for (const g of glyphs) {
    let text = g.str;
    if (prev) {
      const gap = g.x - (prev.x + prev.width);
      if (
        gap > Math.max(prev.size, g.size) * 0.15 &&
        !/\s$/.test(prev.str) &&
        !/^\s/.test(text)
      ) {
        text = " " + text;
      }
    }
    pushRun(runs, { ...styleOf(g), text });
    prev = g;
  }
  const cleaned = cleanRuns(runs);
  return {
    x0: glyphs[0].x,
    x1: Math.max(...glyphs.map((g) => g.x + g.width)),
    glyphs,
    runs: cleaned,
    text: runsText(cleaned),
  };
}

function makeLine(y: number, segments: Segment[]): Line {
  const runs: Run[] = [];
  segments.forEach((seg, i) => {
    if (i > 0) pushRun(runs, { ...runs[runs.length - 1], text: " " });
    for (const run of seg.runs) pushRun(runs, { ...run });
  });
  const glyphs = segments.flatMap((s) => s.glyphs);

  const sizeWeight = new Map<number, number>();
  let chars = 0;
  let boldChars = 0;
  let monoChars = 0;
  for (const g of glyphs) {
    const n = g.str.replace(/\s/g, "").length;
    chars += n;
    if (g.bold) boldChars += n;
    if (g.mono) monoChars += n;
    sizeWeight.set(g.size, (sizeWeight.get(g.size) ?? 0) + n);
  }
  let size = glyphs[0].size;
  let best = -1;
  for (const [s, w] of sizeWeight) {
    if (w > best) {
      best = w;
      size = s;
    }
  }

  return {
    y,
    x0: segments[0].x0,
    x1: segments[segments.length - 1].x1,
    size,
    bold: chars > 0 && boldChars === chars,
    mono: chars > 0 && monoChars === chars,
    segments,
    runs,
    text: runsText(runs),
  };
}

function styleOf(r: Glyph | Run): Omit<Run, "text"> {
  return { bold: r.bold, italic: r.italic, mono: r.mono, link: r.link };
}

function sameStyle(a: Omit<Run, "text">, b: Omit<Run, "text">): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.mono === b.mono &&
    a.link === b.link
  );
}

function pushRun(runs: Run[], run: Run): void {
  const last = runs[runs.length - 1];
  if (last && (sameStyle(last, run) || !run.text.trim())) last.text += run.text;
  else runs.push(run);
}

/** Collapses whitespace across runs and trims the ends. */
function cleanRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    let text = run.text.replace(/\s+/g, " ");
    const prev = out[out.length - 1];
    if ((!prev || /\s$/.test(prev.text)) && text.startsWith(" ")) {
      text = text.slice(1);
    }
    if (text) out.push({ ...run, text });
  }
  const last = out[out.length - 1];
  if (last) {
    last.text = last.text.trimEnd();
    if (!last.text) out.pop();
  }
  return out;
}

function runsText(runs: Run[]): string {
  return runs.map((r) => r.text).join("");
}

/** Appends a new line's runs, joining hyphenated words without a space. */
function appendRuns(target: Run[], runs: Run[]): void {
  const prevText = runsText(target);
  const nextText = runsText(runs);
  const hyphenated = /\p{L}-$/u.test(prevText) && /^\p{Ll}/u.test(nextText);
  if (!hyphenated && prevText && nextText) {
    pushRun(target, { ...styleOf(target[target.length - 1]), text: " " });
  }
  for (const run of runs) pushRun(target, { ...run });
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

function removeRunningHeadersAndFooters(pages: Page[]): void {
  const MARGIN_FRACTION = 0.08;
  const inMargin = (page: Page, line: Line) =>
    line.y >= page.top - page.height * MARGIN_FRACTION ||
    line.y <= page.bottom + page.height * MARGIN_FRACTION;
  const key = (line: Line) =>
    line.text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

  const pagesWithKey = new Map<string, number>();
  for (const page of pages) {
    const keys = new Set(
      page.lines.filter((l) => inMargin(page, l)).map(key),
    );
    for (const k of keys) pagesWithKey.set(k, (pagesWithKey.get(k) ?? 0) + 1);
  }

  const minPages =
    pages.length <= 3 ? 2 : Math.max(3, Math.ceil(pages.length * 0.3));
  for (const page of pages) {
    page.lines = page.lines.filter(
      (line) =>
        !inMargin(page, line) ||
        !(
          (pagesWithKey.get(key(line)) ?? 0) >= minPages ||
          PAGE_NUMBER_RE.test(line.text)
        ),
    );
  }
}

// ---------------------------------------------------------------------------
// Reading order (multi-column pages)
// ---------------------------------------------------------------------------

/**
 * Splits a page into flows of lines in reading order. Two-column pages read
 * the left column then the right, restarting whenever a full-width line
 * (a title or figure caption spanning both columns) interrupts them.
 */
function readingOrder(page: Page): Line[][] {
  const splitX = findColumnGutter(page.lines);
  if (splitX === null) return [page.lines];

  const flows: Line[][] = [];
  let left: Line[] = [];
  let right: Line[] = [];
  let full: Line[] = [];
  const flushColumns = () => {
    if (left.length) flows.push(left);
    if (right.length) flows.push(right);
    left = [];
    right = [];
  };

  for (const line of page.lines) {
    if (line.segments.some((s) => s.x0 < splitX && s.x1 > splitX)) {
      flushColumns();
      full.push(line);
      continue;
    }
    if (full.length) {
      flows.push(full);
      full = [];
    }
    const l = line.segments.filter((s) => s.x1 <= splitX);
    const r = line.segments.filter((s) => s.x0 >= splitX);
    if (l.length) left.push(makeLine(line.y, l));
    if (r.length) right.push(makeLine(line.y, r));
  }
  if (full.length) flows.push(full);
  flushColumns();
  return flows;
}

function findColumnGutter(lines: Line[]): number | null {
  const BIN_WIDTH = 4;
  const MIN_GAP_PT = 12;
  const MAX_OCCUPANCY_IN_GAP = 0.08;

  if (lines.length < 8) return null;

  const segments = lines.flatMap((l) => l.segments);
  const minX = Math.min(...segments.map((s) => s.x0));
  const maxX = Math.max(...segments.map((s) => s.x1));
  const totalWidth = maxX - minX;
  if (totalWidth < MIN_GAP_PT * 8) return null;

  const binCount = Math.ceil(totalWidth / BIN_WIDTH);
  const occupancy = new Array<number>(binCount).fill(0);
  for (const line of lines) {
    const touched = new Set<number>();
    for (const s of line.segments) {
      const start = Math.max(0, Math.floor((s.x0 - minX) / BIN_WIDTH));
      const end = Math.min(binCount - 1, Math.floor((s.x1 - minX) / BIN_WIDTH));
      for (let b = start; b <= end; b++) touched.add(b);
    }
    for (const b of touched) occupancy[b] += 1 / lines.length;
  }

  // A real gutter sits near the middle of the text block.
  const searchStart = Math.floor(binCount * 0.3);
  const searchEnd = Math.ceil(binCount * 0.7);
  let best: { start: number; end: number } | null = null;
  let i = searchStart;
  while (i < searchEnd) {
    if (occupancy[i] > MAX_OCCUPANCY_IN_GAP) {
      i++;
      continue;
    }
    const start = i;
    while (i < binCount && occupancy[i] <= MAX_OCCUPANCY_IN_GAP) i++;
    const end = i - 1;
    if ((end - start + 1) * BIN_WIDTH >= MIN_GAP_PT) {
      if (!best || end - start > best.end - best.start) best = { start, end };
    }
  }
  if (!best) return null;

  const splitX = minX + ((best.start + best.end + 1) / 2) * BIN_WIDTH;
  const gapStart = minX + best.start * BIN_WIDTH;

  // Both sides must carry real text, and the left side must run up to the
  // gutter like justified or ragged column text does. Tables with a narrow
  // label column fail this check and stay in one flow.
  const leftEnds = lines
    .map((l) => Math.max(...l.segments.filter((s) => s.x1 <= splitX).map((s) => s.x1)))
    .filter((x) => Number.isFinite(x));
  const rightCount = lines.filter((l) =>
    l.segments.some((s) => s.x0 >= splitX),
  ).length;
  if (leftEnds.length < lines.length * 0.3 || rightCount < lines.length * 0.3) {
    return null;
  }
  const leftWidth = gapStart - minX;
  if (median(leftEnds) < gapStart - leftWidth * 0.2) return null;

  // Column text is one run per line on each side; several cells side by
  // side on the same half means this is a table with a wide gap.
  const multiCell = lines.filter(
    (l) =>
      l.segments.filter((s) => s.x1 <= splitX).length >= 2 ||
      l.segments.filter((s) => s.x0 >= splitX).length >= 2,
  ).length;
  if (multiCell > lines.length * 0.2) return null;

  return splitX;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function splitTables(lines: Line[]): Region[] {
  // Text regions keep the whole flow so short lines can be measured against
  // the full text width even when the region itself is a few lines.
  const flow = lines;
  const regions: Region[] = [];
  let text: Line[] = [];
  let i = 0;
  while (i < lines.length) {
    const table = lines[i].segments.length >= 2 ? growTable(lines, i) : null;
    if (table) {
      if (text.length) regions.push({ kind: "text", lines: text, flow });
      text = [];
      regions.push({ kind: "table", block: table.block });
      i = table.end;
    } else {
      text.push(lines[i]);
      i++;
    }
  }
  if (text.length) regions.push({ kind: "text", lines: text, flow });
  return regions;
}

/**
 * Starting from a multi-segment line, collects following lines whose
 * segments line up with the same column anchors. Wrapped cell text shows up
 * as lines that fit inside a single column.
 */
function growTable(
  lines: Line[],
  start: number,
): { block: TableBlock; end: number } | null {
  const first = lines[start];
  const size = first.size;
  const tol = Math.max(3, size * 0.5);
  const anchors = first.segments.map((s) => s.x0);
  // Columns announced by the header row; later anchors may be stray offsets.
  const headerAnchors = [...anchors];
  const members: Line[] = [first];
  let multiSegmentLines = 1;
  let maxGap = 0;

  let j = start + 1;
  for (; j < lines.length; j++) {
    const line = lines[j];
    const gap = members[members.length - 1].y - line.y;
    if (gap <= 0 || gap > Math.max(size * 5, maxGap * 1.6)) break;
    // Cells may shrink text to fit, but larger text is a caption or title.
    if (line.size > size * 1.08 || line.size < size * 0.75) break;

    if (line.segments.length === 1) {
      const seg = line.segments[0];
      if (seg.x0 < anchors[0] - tol) break;
      const col = columnFor(seg, headerAnchors, tol);
      if (col < headerAnchors.length - 1 && seg.x1 > headerAnchors[col + 1] + tol) {
        break;
      }
    } else {
      const aligned = line.segments.some((s) =>
        anchors.some((a) => Math.abs(a - s.x0) <= tol),
      );
      if (!aligned) break;
      for (const seg of line.segments) addAnchor(anchors, seg, tol);
      multiSegmentLines++;
    }
    maxGap = Math.max(maxGap, gap);
    members.push(line);
  }

  if (multiSegmentLines < 2 || anchors.length < 2) return null;
  return { block: buildTable(members, anchors, tol), end: j };
}

function addAnchor(anchors: number[], seg: Segment, tol: number): void {
  if (anchors.some((a) => Math.abs(a - seg.x0) <= tol)) return;
  // A segment that straddles an existing column boundary is an overflowing
  // cell, not a new column.
  if (anchors.some((a) => a > seg.x0 + tol && a < seg.x1 - tol)) return;
  anchors.push(seg.x0);
  anchors.sort((a, b) => a - b);
}

function columnFor(seg: Segment, anchors: number[], tol: number): number {
  const exact = anchors.findIndex((a) => Math.abs(a - seg.x0) <= tol);
  if (exact >= 0) return exact;
  let best = 0;
  let bestOverlap = -Infinity;
  anchors.forEach((a, k) => {
    const end = anchors[k + 1] ?? Infinity;
    const overlap = Math.min(seg.x1, end) - Math.max(seg.x0, a);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = k;
    }
  });
  return best;
}

function buildTable(members: Line[], anchors: number[], tol: number): TableBlock {
  const cols = members.map((line) =>
    line.segments.map((s) => columnFor(s, anchors, tol)),
  );

  // Rows are found from vertical spacing (in ems): wrapped lines inside a
  // cell sit one line pitch apart, while row boundaries add cell padding.
  // The first column is top-aligned in almost every table, so a first-column
  // line continues the row only if it sits one pitch below the previous
  // first-column line; this stays reliable when other cells were drawn at odd
  // offsets. Without two distinct spacings, every first-column line starts a
  // row.
  const gaps = members
    .slice(1)
    .map((line, k) => (members[k].y - line.y) / line.size);
  const rowGap = splitPoint(gaps);

  const rows: Segment[][][] = [];
  let prevFirst: Line | null = null;
  members.forEach((line, k) => {
    let newRow: boolean;
    if (k === 0) {
      newRow = true;
    } else if (cols[k].includes(0)) {
      newRow =
        rowGap === null ||
        prevFirst === null ||
        (prevFirst.y - line.y) / line.size > rowGap;
    } else {
      // A row with an empty first cell.
      newRow = rowGap !== null && gaps[k - 1] > rowGap;
    }
    if (cols[k].includes(0)) prevFirst = line;
    if (newRow) rows.push(anchors.map(() => []));
    const row = rows[rows.length - 1];
    line.segments.forEach((s, i) => row[cols[k][i]].push(s));
  });

  const cells = rows.map((row) =>
    row.map((segs) => {
      const runs: Run[] = [];
      for (const s of segs) appendRuns(runs, s.runs);
      return runsText(runs);
    }),
  );
  const columns = [...anchors];

  // A mostly empty column without a header comes from text placed at an odd
  // offset inside a cell (e.g. an edited PDF), not a real column; fold it
  // into its left neighbour.
  for (let c = columns.length - 1; c >= 1; c--) {
    const filled = cells.slice(1).filter((row) => row[c]).length;
    if (cells[0][c] || filled > (cells.length - 1) * 0.6) continue;
    for (const row of cells) {
      row[c - 1] = [row[c - 1], row[c]].filter(Boolean).join(" ");
      row.splice(c, 1);
    }
    columns.splice(c, 1);
  }

  const keep = columns
    .map((_, c) => c)
    .filter((c) => cells.some((row) => row[c].length > 0));
  return {
    kind: "table",
    rows: cells.map((row) => keep.map((c) => row[c])),
    anchors: keep.map((c) => columns[c]),
  };
}

/**
 * Returns a threshold between the two clusters of values (Otsu's method), or
 * null when the values do not form two clearly separated groups. The upper
 * group needs at least two members: a single large gap is usually just the
 * space under a header row.
 */
function splitPoint(values: number[]): number | null {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  let best = { score: 0, k: 0, lowMean: 0, highMean: 0 };
  let lowSum = 0;
  for (let k = 1; k < sorted.length; k++) {
    lowSum += sorted[k - 1];
    const lowMean = lowSum / k;
    const highMean = (total - lowSum) / (sorted.length - k);
    const score = k * (sorted.length - k) * (highMean - lowMean) ** 2;
    if (score > best.score) best = { score, k, lowMean, highMean };
  }
  if (!best.k || sorted.length - best.k < 2) return null;
  if (best.highMean < best.lowMean * 1.4) return null;
  return (sorted[best.k - 1] + sorted[best.k]) / 2;
}

// ---------------------------------------------------------------------------
// Document statistics
// ---------------------------------------------------------------------------

function sizeKey(size: number): number {
  return Math.round(size * 2) / 2;
}

function computeStats(flows: Region[][]): Stats {
  const textRegions = flows
    .flat()
    .filter((r): r is Extract<Region, { kind: "text" }> => r.kind === "text");

  // Body size: the most common size of regular-weight running text.
  const weights = new Map<number, number>();
  for (const region of textRegions) {
    for (const line of region.lines) {
      if (line.bold) continue;
      const k = sizeKey(line.size);
      weights.set(k, (weights.get(k) ?? 0) + line.text.length);
    }
  }
  let bodySize = 12;
  let maxWeight = 0;
  for (const [size, weight] of weights) {
    if (weight > maxWeight) {
      maxWeight = weight;
      bodySize = size;
    }
  }

  // Typical baseline-to-baseline distance per font size. The lower quartile
  // ignores paragraph spacing, which would otherwise inflate it; the cap
  // covers documents where every paragraph is a single line.
  const gapsBySize = new Map<number, number[]>();
  for (const region of textRegions) {
    for (let i = 1; i < region.lines.length; i++) {
      const prev = region.lines[i - 1];
      const line = region.lines[i];
      const gap = prev.y - line.y;
      if (sizeKey(prev.size) !== sizeKey(line.size)) continue;
      if (gap <= 0 || gap > line.size * 3) continue;
      const k = sizeKey(line.size);
      if (!gapsBySize.has(k)) gapsBySize.set(k, []);
      gapsBySize.get(k)!.push(gap);
    }
  }
  const lineGaps = new Map<number, number>();
  for (const [k, gaps] of gapsBySize) {
    lineGaps.set(k, Math.min(quantile(gaps, 0.25), k * 1.6));
  }

  const isHeading = (line: Line) => {
    if (line.mono || !line.text || line.text.length > 160) return false;
    if (!/\p{L}/u.test(line.text)) return false;
    const ratio = line.size / bodySize;
    return (line.bold && ratio >= 1.12) || ratio >= 1.3;
  };

  // Rank distinct heading sizes, largest first; sizes within ~10% share a level.
  const headingSizes = [
    ...new Set(
      textRegions.flatMap((r) =>
        r.lines.filter(isHeading).map((l) => sizeKey(l.size)),
      ),
    ),
  ].sort((a, b) => b - a);
  const levels = new Map<number, number>();
  let level = 0;
  let clusterTop = Infinity;
  for (const size of headingSizes) {
    if (size < clusterTop * 0.9) {
      level++;
      clusterTop = size;
    }
    levels.set(size, Math.min(level, 6));
  }

  return {
    lineGap: (size) => lineGaps.get(sizeKey(size)) ?? size * 1.2,
    headingLevel: (line) =>
      isHeading(line) ? (levels.get(sizeKey(line.size)) ?? 0) : 0,
  };
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function textToBlocks(
  { lines, flow }: Extract<Region, { kind: "text" }>,
  stats: Stats,
): Block[] {
  const blocks: Block[] = [];
  const code = codeLines(lines);
  let prev: Line | null = null;
  let listBaseX = 0;

  for (const line of lines) {
    if (!line.text) continue;
    const last = blocks[blocks.length - 1];
    const gap = prev ? prev.y - line.y : Infinity;
    const breakBefore =
      prev === null || startsNewBlock(prev, line, last, stats, flow);

    const level = stats.headingLevel(line);
    if (level > 0) {
      if (
        last?.kind === "heading" &&
        last.level === level &&
        last.lines < 3 &&
        gap <= line.size * 1.8
      ) {
        last.text += " " + line.text;
        last.lines++;
      } else {
        blocks.push({ kind: "heading", level, text: line.text, lines: 1 });
      }
      prev = line;
      continue;
    }

    if (code.has(line)) {
      if (last?.kind === "code" && gap <= stats.lineGap(line.size) * 3) {
        last.lines.push({ x0: line.x0, text: line.text });
      } else {
        blocks.push({
          kind: "code",
          lines: [{ x0: line.x0, text: line.text }],
          size: line.size,
        });
      }
      prev = line;
      continue;
    }

    const marker = listMarker(line.text, breakBefore || last?.kind === "item");
    if (marker) {
      if (last?.kind !== "item" || line.x0 < listBaseX) listBaseX = line.x0;
      // Nested lists indent by at least ~1.5em; smaller shifts are jitter.
      const depth = Math.floor((line.x0 - listBaseX) / (line.size * 1.5) + 0.2);
      const prevDepth = last?.kind === "item" ? last.depth : -1;
      let runs = dropChars(line.runs, marker.length);
      // Overlapping text layers can leave the bullet glyph doubled.
      const doubled = runsText(runs).match(STRONG_BULLET_RE);
      if (doubled) runs = dropChars(runs, doubled[0].length);
      blocks.push({
        kind: "item",
        runs,
        size: line.size,
        depth: Math.min(depth, prevDepth + 1),
        marker: marker.ordered,
      });
    } else if (
      !breakBefore &&
      (last?.kind === "paragraph" || last?.kind === "item")
    ) {
      appendRuns(last.runs, line.runs);
    } else {
      blocks.push({
        kind: "paragraph",
        runs: line.runs.map((r) => ({ ...r })),
        size: line.size,
      });
    }
    prev = line;
  }
  return blocks;
}

/**
 * Lines to render as code: anything set in a monospace font, plus runs of
 * three or more lines that look like structured data.
 */
function codeLines(lines: Line[]): Set<Line> {
  const code = new Set(lines.filter((l) => l.mono));
  let run: Line[] = [];
  const flush = () => {
    if (run.length >= 3) for (const l of run) code.add(l);
    run = [];
  };
  for (const line of lines) {
    if (DATA_LINE_RE.test(line.text)) run.push(line);
    else flush();
  }
  flush();
  return code;
}

function startsNewBlock(
  prev: Line,
  line: Line,
  last: Block | undefined,
  stats: Stats,
  flow: Line[],
): boolean {
  if (Math.abs(line.size - prev.size) > prev.size * 0.08) return true;
  const gap = prev.y - line.y;
  if (gap <= 0) return true;
  if (gap > stats.lineGap(line.size) * 1.35) return true;
  if (prev.bold !== line.bold) return true;
  // "Label: value" lines, e.g. "Status: Draft".
  const firstRun = line.runs[0];
  if (firstRun?.bold && !line.bold && /:\s*$/.test(firstRun.text)) return true;
  // First-line indent.
  if (last?.kind === "paragraph" && line.x0 - prev.x0 > line.size * 1.2) {
    return true;
  }
  // Wrapped text runs close to the right edge of its block; a line that
  // stops well short of it ended on purpose (end of paragraph, title,
  // formula, address line). The edge comes from lines sharing the same left
  // edge, so narrow boxes and indented blocks are measured on their own.
  const right = Math.max(
    ...flow.filter((l) => Math.abs(l.x0 - prev.x0) <= 3).map((l) => l.x1),
  );
  const shortBy = SENTENCE_END_RE.test(prev.text) ? 0.2 : 0.3;
  if (prev.x1 < right - (right - prev.x0) * shortBy) return true;
  return false;
}

function listMarker(
  text: string,
  canStartWeak: boolean,
): { length: number; ordered: string | null } | null {
  const strong = text.match(STRONG_BULLET_RE);
  if (strong) return { length: strong[0].length, ordered: null };
  if (!canStartWeak) return null;
  const weak = text.match(WEAK_BULLET_RE);
  if (weak) return { length: weak[0].length, ordered: null };
  const numbered = text.match(NUMBERED_RE);
  if (numbered) return { length: numbered[0].length, ordered: `${numbered[1]}.` };
  return null;
}

/** Removes the first `count` characters from a run list. */
function dropChars(runs: Run[], count: number): Run[] {
  const out: Run[] = [];
  let remaining = count;
  for (const run of runs) {
    if (remaining >= run.text.length) {
      remaining -= run.text.length;
      continue;
    }
    out.push({ ...run, text: run.text.slice(remaining) });
    remaining = 0;
  }
  return cleanRuns(out);
}

/** Appends blocks, stitching content that continues across a column or page. */
function appendBlocks(target: Block[], next: Block[]): void {
  const last = target[target.length - 1];
  const first = next[0];
  if (last && first) {
    const repeatedHeader =
      last.kind === "table" &&
      first.kind === "table" &&
      first.rows[0].join("\u0000") === last.rows[0].join("\u0000");
    if (
      last.kind === "table" &&
      first.kind === "table" &&
      last.anchors.length === first.anchors.length &&
      (repeatedHeader ||
        last.anchors.every((a, i) => Math.abs(a - first.anchors[i]) <= 3))
    ) {
      last.rows.push(...first.rows.slice(repeatedHeader ? 1 : 0));
      next = next.slice(1);
    } else if (last.kind === "code" && first.kind === "code") {
      last.lines.push(...first.lines);
      next = next.slice(1);
    } else if (
      (last.kind === "paragraph" || last.kind === "item") &&
      first.kind === "paragraph" &&
      Math.abs(first.size - last.size) <= last.size * 0.08 &&
      !SENTENCE_END_RE.test(runsText(last.runs)) &&
      /^\p{Ll}/u.test(runsText(first.runs))
    ) {
      appendRuns(last.runs, first.runs);
      next = next.slice(1);
    }
  }
  target.push(...next);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(blocks: Block[]): string {
  let out = "";
  blocks.forEach((block, i) => {
    const rendered = renderBlock(block);
    if (!rendered) return;
    if (out) {
      const prev = blocks[i - 1];
      out += block.kind === "item" && prev?.kind === "item" ? "\n" : "\n\n";
    }
    out += rendered;
  });
  return out;
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case "heading":
      return `${"#".repeat(block.level)} ${escapeMarkdown(block.text)}`;
    case "paragraph":
      return escapeBlockStart(renderRuns(block.runs));
    case "item": {
      // Four spaces per level nests under both "- " and "10. " parents.
      const indent = "    ".repeat(block.depth);
      return `${indent}${block.marker ?? "-"} ${renderRuns(block.runs)}`;
    }
    case "code": {
      const minX = Math.min(...block.lines.map((l) => l.x0));
      const charWidth = block.size * 0.6;
      const body = block.lines
        .map((l) => " ".repeat(Math.round((l.x0 - minX) / charWidth)) + l.text)
        .join("\n");
      const fence = body.includes("```") ? "~~~" : "```";
      return `${fence}\n${body}\n${fence}`;
    }
    case "table":
      return renderTable(block.rows);
  }
}

function renderTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (text: string) => escapeMarkdown(text).replace(/\|/g, "\\|");
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cell(row[i] ?? "")).join(" | ")} |`;
  return [
    line(rows[0]),
    `|${" --- |".repeat(width)}`,
    ...rows.slice(1).map(line),
  ].join("\n");
}

function renderRuns(runs: Run[]): string {
  let out = "";
  for (const run of runs) {
    const [, lead, core, trail] = run.text.match(/^(\s*)(.*?)(\s*)$/s)!;
    if (!core) {
      out += run.text;
      continue;
    }
    let text: string;
    if (run.mono) {
      const tick = core.includes("`") ? "``" : "`";
      text = `${tick}${core}${tick}`;
    } else {
      text = escapeMarkdown(core);
      if (run.bold && run.italic) text = `***${text}***`;
      else if (run.bold) text = `**${text}**`;
      else if (run.italic) text = `*${text}*`;
    }
    if (run.link) text = `[${text}](${run.link.replace(/[()\s]/g, encodeURIComponent)})`;
    out += lead + text + trail;
  }
  return out;
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*[\]]/g, "\\$&")
    .replace(/<(?=[A-Za-z/!?])/g, "\\<")
    .replace(/&(?=#?\w+;)/g, "\\&")
    .replace(/_/g, (_m, offset: number, str: string) => {
      const before = str[offset - 1] ?? "";
      const after = str[offset + 1] ?? "";
      const intraword =
        /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after);
      return intraword ? "_" : "\\_";
    });
}

/** Stops paragraph text from being read as a heading, list or quote. */
function escapeBlockStart(text: string): string {
  const numbered = text.match(/^(\d{1,9})([.)])(\s)/);
  if (numbered) return `${numbered[1]}\\${text.slice(numbered[1].length)}`;
  if (/^(#{1,6}(\s|$)|>|[-+*]\s|={3,}\s*$|-{3,}\s*$)/.test(text)) {
    return "\\" + text;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  return quantile(values, 0.5);
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
