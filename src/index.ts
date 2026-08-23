import * as pdfjsLib from "pdfjs-dist";

export interface PdfToMarkdownOptions {
  pageBreaks?: boolean;
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
}

interface Line {
  text: string;
  y: number;
  maxFontSize: number;
}

const BULLET_RE = /^[•‣◦●○*-]\s+/;
const NUMBERED_RE = /^(\d+)[.)]\s+/;

export async function pdfToMarkdown(
  data: Uint8Array | ArrayBuffer | Buffer,
  options: PdfToMarkdownOptions = {},
): Promise<string> {
  const bytes = toPlainUint8Array(data);

  const doc = await pdfjsLib.getDocument({ data: bytes, verbosity: 0 }).promise;

  const pageColumns: { left: Line[]; right: Line[] }[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const items = (content.items as unknown as TextItem[]).filter(
      (i) => "str" in i,
    );
    const nonBlankItems = items.filter((i) => i.str.trim().length > 0);

    const splitX = findColumnGutter(nonBlankItems);
    if (splitX === null) {
      pageColumns.push({ left: groupIntoLines(items), right: [] });
    } else {
      const left = items.filter((i) => i.transform[4] < splitX);
      const right = items.filter((i) => i.transform[4] >= splitX);
      pageColumns.push({
        left: groupIntoLines(left),
        right: groupIntoLines(right),
      });
    }
  }
  await doc.destroy();

  const allLines = pageColumns.flatMap((p) => [...p.left, ...p.right]);
  const bodyFontSize = detectBodyFontSize(allLines);

  const pageMarkdown = pageColumns.map(({ left, right }) => {
    const leftMd = linesToMarkdown(left, bodyFontSize);
    const rightMd = linesToMarkdown(right, bodyFontSize);
    return [leftMd, rightMd].filter((s) => s.length > 0).join("\n\n");
  });

  const separator = options.pageBreaks ? "\n\n---\n\n" : "\n\n";
  return (
    pageMarkdown
      .filter((p) => p.length > 0)
      .join(separator)
      .trim() + "\n"
  );
}

function toPlainUint8Array(
  data: Uint8Array | ArrayBuffer | Buffer,
): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

function groupIntoLines(items: TextItem[]): Line[] {
  const Y_TOLERANCE = 2;

  const rows: { y: number; parts: TextItem[] }[] = [];
  for (const item of items) {
    const y = item.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) <= Y_TOLERANCE);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push(item);
  }

  rows.sort((a, b) => b.y - a.y);

  return rows.map((row) => {
    row.parts.sort((a, b) => a.transform[4] - b.transform[4]);
    const text = row.parts
      .map((p) => p.str)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    const maxFontSize = Math.max(...row.parts.map((p) => p.transform[0]));
    return { text, y: row.y, maxFontSize };
  });
}

function findColumnGutter(items: TextItem[]): number | null {
  const BIN_WIDTH = 4;
  const MIN_GAP_PT = 12;
  const MAX_OCCUPANCY_IN_GAP = 0.08;
  const MIN_SIDE_OCCUPANCY = 0.25;
  const MARGIN_FRACTION = 0.1;

  if (items.length < 6) return null;

  const xs = items.flatMap((i) => [i.transform[4], i.transform[4] + i.width]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const totalWidth = maxX - minX;
  if (totalWidth < MIN_GAP_PT * 4) return null;

  const rowOf = (y: number) => Math.round(y / 4);
  const totalRows = new Set(items.map((i) => rowOf(i.transform[5]))).size;

  const binCount = Math.ceil(totalWidth / BIN_WIDTH);
  const binRows: Set<number>[] = Array.from(
    { length: binCount },
    () => new Set(),
  );
  for (const item of items) {
    const x0 = item.transform[4];
    const x1 = x0 + item.width;
    const startBin = Math.max(0, Math.floor((x0 - minX) / BIN_WIDTH));
    const endBin = Math.min(binCount - 1, Math.floor((x1 - minX) / BIN_WIDTH));
    const row = rowOf(item.transform[5]);
    for (let b = startBin; b <= endBin; b++) binRows[b].add(row);
  }
  const occupancy = binRows.map((rows) => rows.size / totalRows);

  const marginBins = Math.floor(binCount * MARGIN_FRACTION);
  const searchStart = marginBins;
  const searchEnd = binCount - marginBins;

  let bestGap: { start: number; end: number } | null = null;
  let i = searchStart;
  while (i < searchEnd) {
    if (occupancy[i] > MAX_OCCUPANCY_IN_GAP) {
      i++;
      continue;
    }
    const start = i;
    while (i < searchEnd && occupancy[i] <= MAX_OCCUPANCY_IN_GAP) i++;
    const end = i - 1;
    const widthPt = (end - start + 1) * BIN_WIDTH;
    if (widthPt >= MIN_GAP_PT) {
      if (!bestGap || end - start > bestGap.end - bestGap.start) {
        bestGap = { start, end };
      }
    }
  }
  if (!bestGap) return null;

  const leftWindow = occupancy.slice(searchStart, bestGap.start);
  const rightWindow = occupancy.slice(bestGap.end + 1, searchEnd);
  const leftOk = Math.max(0, ...leftWindow) >= MIN_SIDE_OCCUPANCY;
  const rightOk = Math.max(0, ...rightWindow) >= MIN_SIDE_OCCUPANCY;
  if (!leftOk || !rightOk) return null;

  const gapCenterBin = (bestGap.start + bestGap.end) / 2;
  return minX + gapCenterBin * BIN_WIDTH;
}

function detectBodyFontSize(lines: Line[]): number {
  const counts = new Map<number, number>();
  for (const line of lines) {
    if (!line.text) continue;
    const rounded = Math.round(line.maxFontSize);
    counts.set(rounded, (counts.get(rounded) ?? 0) + line.text.length);
  }
  let bodySize = 12;
  let max = 0;
  for (const [size, weight] of counts) {
    if (weight > max) {
      max = weight;
      bodySize = size;
    }
  }
  return bodySize;
}

function headingLevel(fontSize: number, bodyFontSize: number): number {
  const ratio = fontSize / bodyFontSize;
  if (ratio >= 1.8) return 1;
  if (ratio >= 1.5) return 2;
  if (ratio >= 1.25) return 3;
  if (ratio >= 1.1) return 4;
  return 0;
}

function linesToMarkdown(lines: Line[], bodyFontSize: number): string {
  const blocks: string[] = [];
  let paragraphBuffer: string[] = [];
  let prevY: number | null = null;
  let lineHeight: number | null = null;

  const flushParagraph = () => {
    if (paragraphBuffer.length > 0) {
      blocks.push(paragraphBuffer.join(" "));
      paragraphBuffer = [];
    }
  };

  for (const line of lines) {
    if (!line.text) continue;

    const gap = prevY !== null ? prevY - line.y : 0;
    if (lineHeight === null && gap > 0) lineHeight = gap;
    const isNewParagraph = lineHeight !== null && gap > lineHeight * 1.6;
    prevY = line.y;

    const level = headingLevel(line.maxFontSize, bodyFontSize);
    if (level > 0) {
      flushParagraph();
      blocks.push(`${"#".repeat(level)} ${escapeMarkdown(line.text)}`);
      continue;
    }

    const bulletMatch = line.text.match(BULLET_RE);
    const numberedMatch = line.text.match(NUMBERED_RE);
    if (bulletMatch) {
      flushParagraph();
      blocks.push(
        `- ${escapeMarkdown(line.text.slice(bulletMatch[0].length))}`,
      );
      continue;
    }
    if (numberedMatch) {
      flushParagraph();
      blocks.push(
        `${numberedMatch[1]}. ${escapeMarkdown(
          line.text.slice(numberedMatch[0].length),
        )}`,
      );
      continue;
    }

    const text = escapeMarkdown(line.text);

    if (isNewParagraph) flushParagraph();
    paragraphBuffer.push(text);
  }
  flushParagraph();

  return blocks.join("\n\n");
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]|])/g, "\\$1");
}
