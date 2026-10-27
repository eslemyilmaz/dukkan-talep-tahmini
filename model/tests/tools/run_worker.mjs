// Runs the app's report parser (sales-worker.js) in Node and prints its result as JSON.
// Usage: node run_worker.mjs <report.xls|report.zip> [path/to/sales-worker.js]
// Node >= 18 provides TextDecoderStream, DecompressionStream, ReadableStream, Blob and File;
// only the Web Worker globals (self, postMessage, onmessage) are shimmed here.
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const report = process.argv[2];
const worker = process.argv[3] || resolve(here, "../../../sales-worker.js");
if (!report) {
  console.error("kullanım: node run_worker.mjs <rapor> [sales-worker.js]");
  process.exit(2);
}

const messages = [];
let settle;
const finished = new Promise((r) => (settle = r));
globalThis.self = globalThis;
globalThis.postMessage = (msg) => {
  messages.push(msg);
  if (msg && (msg.result || msg.error)) settle(msg);
};
globalThis.onmessage = null;
vm.runInThisContext(readFileSync(worker, "utf8"), { filename: worker });
if (typeof globalThis.onmessage !== "function") {
  console.error("sales-worker.js onmessage tanımlamadı");
  process.exit(2);
}

const file = new File([readFileSync(report)], basename(report));
globalThis.onmessage({ data: file });
const msg = await finished;
process.stdout.write(JSON.stringify(msg.result ? { result: msg.result } : { error: msg.error }));
