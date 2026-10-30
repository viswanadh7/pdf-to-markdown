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
- **Running headers, footers and page numbers** repeated across pages are
  removed.

Scanned PDFs (images without a text layer) produce no text; run OCR first.

### Options

```ts
await pdfToMarkdown(data, {
  pageBreaks: true, // separate pages with a `---` rule instead of joining them. Default: false
  keepHeadersFooters: true, // keep running headers, footers and page numbers. Default: false
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
