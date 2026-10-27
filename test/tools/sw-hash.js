// Short hash of the app shell listed in sw.js (ASSETS), stored in sw.js as SHELL_HASH so that changing any
// shell file also changes sw.js and the browser installs the worker again with a new cache name.
//   node test/tools/sw-hash.js           prints the hash
//   node test/tools/sw-hash.js --write   rewrites SHELL_HASH in sw.js (npm run sw:hash)
// Text files are hashed with LF line endings, so a CRLF checkout gives the same hash.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const SW = path.join(ROOT, "sw.js");
const HASH_RE = /const SHELL_HASH = "([0-9a-f]*)";/;
const BINARY = /\.(png|jpe?g|gif|webp|ico)$/i;

function parseSw(text) {
  const list = /const ASSETS = \[([\s\S]*?)\];/.exec(text);
  const hash = HASH_RE.exec(text);
  if (!list || !hash) throw Error("sw.js: ASSETS or SHELL_HASH not found");
  return { assets: [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]), hash: hash[1] };
}

// "./" is the directory index, which is index.html (listed on its own as well).
function shellHash(assets, root = ROOT) {
  const h = crypto.createHash("sha256");
  for (const asset of assets) {
    const file = asset.endsWith("/") ? asset + "index.html" : asset;
    let bytes = fs.readFileSync(path.join(root, file));
    if (!BINARY.test(file)) bytes = Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"));
    h.update(asset + "\0");
    h.update(bytes);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 8);
}

function current() {
  const text = fs.readFileSync(SW, "utf8");
  const { assets, hash } = parseSw(text);
  return { text, assets, stored: hash, actual: shellHash(assets) };
}

if (require.main === module) {
  const { text, stored, actual } = current();
  if (process.argv.includes("--write")) {
    if (stored !== actual) fs.writeFileSync(SW, text.replace(HASH_RE, `const SHELL_HASH = "${actual}";`));
    console.log(stored === actual ? `SHELL_HASH ${actual} (unchanged)` : `SHELL_HASH ${stored} -> ${actual}`);
  } else console.log(actual);
}

module.exports = { parseSw, shellHash, current };
