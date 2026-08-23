import { readFileSync } from "fs";
import { pdfToMarkdown } from "../dist/index.js";

const data = readFileSync(new URL("./sample.pdf", import.meta.url));
const markdown = await pdfToMarkdown(data);

console.log(markdown);
