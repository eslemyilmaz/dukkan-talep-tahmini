"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { current } = require("../tools/sw-hash.js");

const ROOT = path.resolve(__dirname, "..", "..");

test("sw.js SHELL_HASH matches the files in ASSETS", () => {
  const { assets, stored, actual } = current();
  for (const a of assets) assert.ok(fs.existsSync(path.join(ROOT, a)), `ASSETS lists a missing file: ${a}`);
  assert.equal(
    stored,
    actual,
    `A shell file changed but sw.js was not updated, so installed apps would keep the old files. ` +
      `Run \`npm run sw:hash\` and commit sw.js.`,
  );
});

test("the cache name is derived from SHELL_VERSION, which carries SHELL_HASH", () => {
  const text = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  assert.match(text, /const SHELL_VERSION = "\d+-" \+ SHELL_HASH;/);
  assert.match(text, /const CACHE = "dukkan-shell-v" \+ SHELL_VERSION;/);
});
