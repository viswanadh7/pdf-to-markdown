import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

/** An image drawn on a page, in PDF user-space coordinates. */
export interface PageImage {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** Content hash; identical images share one embedded copy. */
  key: string;
  /** `data:image/png;base64,...` */
  src: string;
}

interface DecodedImage {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
}

type Matrix = [number, number, number, number, number, number];

// Images smaller than this are icons, bullets or rules rather than content.
const MIN_RENDERED_PT = 12;
const MIN_PIXELS = 16;
const DECODE_TIMEOUT_MS = 10_000;

/**
 * Walks the page's drawing operators, tracking the transformation matrix, to
 * find every raster image together with where it lands on the page.
 */
export async function extractImages(
  page: pdfjsLib.PDFPageProxy,
  ops: { fnArray: number[]; argsArray: unknown[][] },
  maxDpi: number,
): Promise<PageImage[]> {
  const { OPS } = pdfjsLib;
  const placements: { image: Promise<DecodedImage | null>; ctm: Matrix }[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];

  ops.fnArray.forEach((fn, i) => {
    const args = ops.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform:
        ctm = multiply(ctm, args as Matrix);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args[0])) ctm = multiply(ctm, args[0] as Matrix);
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.paintImageXObject:
        placements.push({ image: resolveObject(page, args[0] as string), ctm });
        break;
      case OPS.paintInlineImageXObject:
        placements.push({
          image: Promise.resolve(args[0] as DecodedImage),
          ctm,
        });
        break;
    }
  });

  const images: PageImage[] = [];
  for (const { image, ctm } of placements) {
    const box = unitSquareBounds(ctm);
    if (box.x1 - box.x0 < MIN_RENDERED_PT || box.top - box.bottom < MIN_RENDERED_PT) {
      continue;
    }
    const decoded = await image;
    if (!decoded || decoded.width < MIN_PIXELS || decoded.height < MIN_PIXELS) {
      continue;
    }
    // Points are 1/72 inch; cap pixels to what maxDpi needs at printed size.
    const scale = Math.min(
      1,
      (((box.x1 - box.x0) / 72) * maxDpi) / decoded.width,
      (((box.top - box.bottom) / 72) * maxDpi) / decoded.height,
    );
    const png = toPng(decoded, scale);
    if (!png) continue;
    images.push({
      ...box,
      key: createHash("sha1").update(png).digest("hex"),
      src: `data:image/png;base64,${png.toString("base64")}`,
    });
  }
  return images;
}

function resolveObject(
  page: pdfjsLib.PDFPageProxy,
  id: string,
): Promise<DecodedImage | null> {
  // Images shared across pages live in commonObjs ("g_" prefix).
  const store = id.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), DECODE_TIMEOUT_MS);
    try {
      store.get(id, (data: unknown) => {
        clearTimeout(timer);
        resolve((data as DecodedImage) ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** Images are painted into the unit square; map it through the matrix. */
function unitSquareBounds(m: Matrix) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    xs.push(m[0] * u + m[2] * v + m[4]);
    ys.push(m[1] * u + m[3] * v + m[5]);
  }
  return {
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    bottom: Math.min(...ys),
    top: Math.max(...ys),
  };
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

/** Converts pdf.js decoded pixels (see pdfjsLib.ImageKind) to a PNG file. */
function toPng(
  { width, height, kind, data }: DecodedImage,
  scale: number,
): Buffer | null {
  if (!data) return null;
  const { ImageKind } = pdfjsLib;
  let channels: 1 | 3 | 4;
  let pixels: Uint8Array;

  if (kind === ImageKind.GRAYSCALE_1BPP) {
    // One bit per pixel, rows padded to whole bytes; a set bit is white.
    channels = 1;
    pixels = new Uint8Array(width * height);
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = data[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7));
        pixels[y * width + x] = bit ? 255 : 0;
      }
    }
  } else if (kind === ImageKind.RGB_24BPP) {
    channels = 3;
    pixels = new Uint8Array(data.buffer, data.byteOffset, width * height * 3);
  } else if (kind === ImageKind.RGBA_32BPP) {
    pixels = new Uint8Array(data.buffer, data.byteOffset, width * height * 4);
    channels = 4;
    // Drop a fully opaque alpha channel; it only adds size.
    let opaque = true;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 255) {
        opaque = false;
        break;
      }
    }
    if (opaque) {
      const rgb = new Uint8Array(width * height * 3);
      for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
        rgb[j] = pixels[i];
        rgb[j + 1] = pixels[i + 1];
        rgb[j + 2] = pixels[i + 2];
      }
      pixels = rgb;
      channels = 3;
    }
  } else {
    return null;
  }
  if (pixels.length < width * height * channels) return null;

  if (scale < 0.95) {
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    pixels = downscale(pixels, width, height, channels, w, h);
    width = w;
    height = h;
  }

  const raw = filterScanlines(pixels, width * channels, height, channels);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = { 1: 0, 3: 2, 4: 6 }[channels]; // grey, RGB, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Area-averaging downscale: each target pixel averages the source box it covers. */
function downscale(
  src: Uint8Array,
  width: number,
  height: number,
  channels: number,
  w: number,
  h: number,
): Uint8Array {
  const dst = new Uint8Array(w * h * channels);
  const sums = new Float64Array(channels);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      sums.fill(0);
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * width + x0) * channels;
        for (let sx = x0; sx < x1; sx++) {
          for (let c = 0; c < channels; c++) sums[c] += src[i++];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * channels;
      for (let c = 0; c < channels; c++) dst[o + c] = Math.round(sums[c] / n);
    }
  }
  return dst;
}

/**
 * Applies PNG prediction filters, picking for each scanline the filter with
 * the smallest sum of absolute residuals (the libpng heuristic). Lossless,
 * and usually shrinks screenshots and diagrams by a third or more.
 */
function filterScanlines(
  pixels: Uint8Array,
  stride: number,
  height: number,
  bpp: number,
): Buffer {
  const out = Buffer.alloc((stride + 1) * height);
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const zero = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const dst = candidates[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = up[i];
        const c = i >= bpp ? up[i - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) pred = paeth(a, b, c);
        const v = (row[i] - pred) & 0xff;
        dst[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    const offset = y * (stride + 1);
    out[offset] = best;
    out.set(candidates[best], offset + 1);
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function pngChunk(type: string, body: Buffer): Buffer {
  const chunk = Buffer.alloc(body.length + 12);
  chunk.writeUInt32BE(body.length, 0);
  chunk.write(type, 4, "ascii");
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + body.length)), 8 + body.length);
  return chunk;
}

let crcTable: Uint32Array | null = null;

// zlib.crc32 needs Node 20.15+, so compute it here to keep Node 18 support.
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
