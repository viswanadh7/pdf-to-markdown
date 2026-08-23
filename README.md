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

### Options

```ts
await pdfToMarkdown(data, {
  pageBreaks: true, // insert a `---` rule between pages. Default: false
});
```

## Requirements

Node.js 18+. Published as an ES module (`import`, not `require`).

## License

MIT
