# pdf-to-markdown

Convert PDF files to Markdown in Node.js/TypeScript, using layout heuristics
rather than a fixed mapping — no LLM, no external service, no native
dependencies.

## Install

```sh
npm install @viswanadh_mudunuru/pdf-to-markdown
```

## Usage

```ts
import { readFile } from "node:fs/promises";
import { pdfToMarkdown } from "@viswanadh_mudunuru/pdf-to-markdown";

const data = await readFile("report.pdf");
const markdown = await pdfToMarkdown(data);

console.log(markdown);
```

`pdfToMarkdown` accepts a `Buffer`, `Uint8Array`, or `ArrayBuffer` and
resolves to a Markdown string.

### What it detects

- **Headings** from font size and weight relative to the document's body
  text; multi-line headings are joined.
- **Paragraphs**, with wrapped lines and hyphenated words joined, including
  paragraphs that continue across columns and pages.
- **Bold, italic, inline code and links** inside running text.
- **Bulleted and numbered lists**, including wrapped and nested items.
- **Tables** from column alignment, with wrapped cells kept together and
  tables that continue onto the next page merged (repeated header rows are
  dropped).
- **Two-column layouts**, read left column first; full-width titles that
  span both columns are kept in place.
- **Code blocks** from monospace fonts, and JSON-like data blocks.
- **Images**, embedded in the Markdown file itself as base64 PNG data URIs
  at their position in the text (see below).
- **Running headers, footers and page numbers** repeated across pages are
  removed.

Scanned PDFs (images without a text layer) produce only images, no text;
run OCR first if you need the text.

### Images

Images are written as reference-style links so the text stays readable; the
image data is defined once at the end of the file, and an image that appears
several times is stored once:

```md
Text before the figure.

![Image 1][image-1]

Text after the figure.

[image-1]: data:image/png;base64,iVBORw0KGgo...
```

Images are re-encoded as lossless PNG and downscaled to at most 144 DPI at
their printed size, which is sharp on high-density screens while keeping
files small. Tiny images (icons, bullets) and logos repeated in the page
header or footer are skipped.

Data-URI images render in VS Code, Obsidian, Typora and most Markdown
viewers, but GitHub strips them for security, so they do not display there.

### Options

```ts
await pdfToMarkdown(data, {
  pageBreaks: true, // separate pages with a `---` rule instead of joining them. Default: false
  keepHeadersFooters: true, // keep running headers, footers and page numbers. Default: false
  images: false, // leave images out. Default: true
  imageDpi: 300, // max image resolution at printed size; Infinity keeps originals. Default: 144
});
```

## Development

```sh
npm test        # build, then run the regression tests (PDFs generated with pdfkit)
npm run sample  # build, then convert test/sample.pdf to test/sample.md
```

## Requirements

Node.js 18+. Published as an ES module (`import`, not `require`).

## License

MIT
