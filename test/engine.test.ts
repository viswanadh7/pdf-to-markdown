import { test } from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import { pdfToMarkdown, type PdfToMarkdownOptions } from "../dist/index.js";

type Doc = InstanceType<typeof PDFDocument>;

async function render(
  draw: (doc: Doc) => void,
  options: PdfToMarkdownOptions = {},
): Promise<string> {
  const doc = new PDFDocument({ size: "A4", margin: 60 });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", resolve));
  draw(doc);
  doc.end();
  await done;
  return pdfToMarkdown(Buffer.concat(chunks), options);
}


const LOREM =
  "The quick brown fox jumps over the lazy dog while the committee reviews " +
  "every clause of the agreement, line by line, until all of the open " +
  "questions are resolved and the final draft is ready for signature.";

test("headings by size and wrapped paragraphs joined", async () => {
  const md = await render((doc) => {
    doc.font("Helvetica-Bold").fontSize(22).text("Annual Report");
    doc.moveDown();
    doc.font("Helvetica-Bold").fontSize(15).text("1. Overview");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(10).text(LOREM + " " + LOREM);
    doc.moveDown();
    doc.text("A second paragraph follows after a blank line.");
    doc.moveDown();
    doc.font("Helvetica-Bold").fontSize(15).text("2. Details");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(10).text(LOREM);
  });

  assert.match(md, /^# Annual Report$/m);
  assert.match(md, /^## 1\. Overview$/m);
  assert.match(md, /^## 2\. Details$/m);
  assert.ok(md.includes(`\n\n${LOREM} ${LOREM}\n\n`), md);
  assert.match(md, /^A second paragraph follows after a blank line\.$/m);
});

test("inline bold and italic runs", async () => {
  const md = await render((doc) => {
    doc.font("Helvetica").fontSize(10).text("Plain text with ", { continued: true });
    doc.font("Helvetica-Bold").text("bold words", { continued: true });
    doc.font("Helvetica").text(" and ", { continued: true });
    doc.font("Helvetica-Oblique").text("italic words", { continued: true });
    doc.font("Helvetica").text(" inside.");
  });
  assert.equal(
    md.trim(),
    "Plain text with **bold words** and *italic words* inside.",
  );
});

test("bullet and numbered lists with wrapped items", async () => {
  const md = await render((doc) => {
    doc.font("Helvetica").fontSize(10);
    doc.text("• Short item");
    doc.text(`• ${LOREM}`);
    doc.text("• Last item");
    doc.moveDown();
    doc.text("1. First step");
    doc.text("2. Second step");
  });
  assert.match(md, /^- Short item\n- The quick brown fox .* for signature\.\n- Last item$/m);
  assert.match(md, /^1\. First step\n2\. Second step$/m);
});

test("tables with wrapped cells, split across pages", async () => {
  const md = await render((doc) => {
    const cols = [60, 160, 330];
    const row = (cells: string[], y: number, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
      cells.forEach((c, i) => doc.text(c, cols[i], y, { width: 150, lineBreak: true }));
    };
    const table = (startId: number, top: number) => {
      row(["ID", "Name", "Description"], top, true);
      let y = top + 22;
      for (let id = startId; id < startId + 3; id++) {
        row(
          [`R-${id}`, `Item ${id}`, id % 2 ? "Short." : "A longer description that wraps onto a second line."],
          y,
        );
        y += 34;
      }
    };
    doc.font("Helvetica-Bold").fontSize(14).text("Inventory", 60, 60);
    table(1, 100);
    doc.addPage();
    table(4, 60);
  });

  assert.ok(
    md.includes(
      [
        "| ID | Name | Description |",
        "| --- | --- | --- |",
        "| R-1 | Item 1 | Short. |",
        "| R-2 | Item 2 | A longer description that wraps onto a second line. |",
        "| R-3 | Item 3 | Short. |",
        "| R-4 | Item 4 | A longer description that wraps onto a second line. |",
      ].join("\n"),
    ),
    md,
  );
  // The header repeated on the second page is dropped, not duplicated.
  assert.equal(md.match(/\| ID \| Name/g)?.length, 1, md);
});

test("two-column pages read left column before right", async () => {
  const words = Array.from({ length: 260 }, (_, i) => `w${i}`).join(" ");
  const md = await render((doc) => {
    doc.font("Helvetica-Bold").fontSize(18).text("Two Column Article");
    doc.moveDown();
    doc.font("Helvetica").fontSize(10).text(words, { columns: 2, columnGap: 24, height: 200 });
  });
  assert.match(md, /^# Two Column Article$/m);
  const body = md.replace(/^#.*$/m, "").replace(/\s+/g, " ").trim();
  assert.equal(body, words);
});

test("running headers, footers and page numbers are removed", async () => {
  const md = await render((doc) => {
    for (let page = 1; page <= 3; page++) {
      if (page > 1) doc.addPage();
      doc.font("Helvetica").fontSize(8).text("ACME CORP · CONFIDENTIAL", 60, 30);
      doc.fontSize(8).text(`Page ${page} of 3`, 60, 800);
      doc.fontSize(10).text(`Body text on page ${page}.`, 60, 120);
    }
  });
  assert.doesNotMatch(md, /ACME|Page \d/);
  assert.match(md, /Body text on page 1\./);
  assert.match(md, /Body text on page 3\./);
});

test("keepHeadersFooters retains page furniture", async () => {
  const chunks: Buffer[] = [];
  const doc = new PDFDocument({ size: "A4", margin: 60 });
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", resolve));
  for (let page = 1; page <= 3; page++) {
    if (page > 1) doc.addPage();
    doc.font("Helvetica").fontSize(8).text("ACME CORP", 60, 30);
    doc.fontSize(10).text(`Body ${page}.`, 60, 120);
  }
  doc.end();
  await done;
  const md = await pdfToMarkdown(Buffer.concat(chunks), {
    keepHeadersFooters: true,
  });
  assert.equal(md.match(/ACME CORP/g)?.length, 3);
});

test("paragraph continues across a page break", async () => {
  const long = Array.from({ length: 12 }, () => LOREM).join(" ");
  const md = await render((doc) => {
    doc.font("Helvetica").fontSize(10);
    doc.y = 720;
    doc.text(long);
  });
  assert.equal(md.trim(), long);
});

test("monospace lines become a fenced code block", async () => {
  const md = await render((doc) => {
    doc.font("Helvetica").fontSize(10).text("Example:");
    doc.moveDown(0.5);
    doc.font("Courier").fontSize(9);
    doc.text("function add(a, b) {");
    doc.text("  return a + b;", { indent: 0 });
    doc.text("}");
  });
  assert.match(md, /```\nfunction add\(a, b\) \{\n {2}return a \+ b;\n\}\n```/);
});

test("links and markdown escaping", async () => {
  const md = await render((doc) => {
    doc.font("Helvetica").fontSize(10);
    doc.text("Docs", { link: "https://example.com/docs" });
    doc.moveDown();
    doc.text("Use a*b and _private and [x] literally, but snake_case stays.");
    doc.moveDown();
    doc.text("# not a heading");
  });
  assert.match(md, /^\[Docs\]\(https:\/\/example\.com\/docs\)$/m);
  assert.match(
    md,
    /^Use a\\\*b and \\_private and \\\[x\\\] literally, but snake_case stays\.$/m,
  );
  assert.match(md, /^\\# not a heading$/m);
});

test("pageBreaks option separates pages", async () => {
  const chunks: Buffer[] = [];
  const doc = new PDFDocument({ size: "A4", margin: 60 });
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", resolve));
  doc.font("Helvetica").fontSize(10).text("first page");
  doc.addPage();
  doc.text("second page");
  doc.end();
  await done;
  const md = await pdfToMarkdown(Buffer.concat(chunks), { pageBreaks: true });
  assert.equal(md, "first page\n\n---\n\nsecond page\n");
});

test("narrow indented blocks still join wrapped lines", async () => {
  const md = await render((doc) => {
    doc.font("Helvetica").fontSize(10).text(LOREM, 60, 60, { width: 470 });
    doc.moveDown();
    doc.text(LOREM, 200, doc.y, { width: 180 });
    doc.moveDown();
    doc.text("Short line one", 60);
    doc.text("Short line two");
  });
  assert.equal(
    md.trim(),
    `${LOREM}\n\n${LOREM}\n\nShort line one\n\nShort line two`,
  );
});
