import { readFileSync, writeFileSync } from "fs";
import { pdfToMarkdown } from "../dist/index.js";

const data = readFileSync(new URL("./sample.pdf", import.meta.url));
const markdown = await pdfToMarkdown(data);

writeFileSync(new URL("./sample.md", import.meta.url), markdown, "utf8");