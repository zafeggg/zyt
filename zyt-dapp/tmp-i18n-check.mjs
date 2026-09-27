import fs from "node:fs";
import path from "node:path";

const root = "src";
const src = fs.readFileSync(path.join(root, "i18n", "zh-CN.ts"), "utf8");

// 解析 zh-CN.ts 的二级键：`  block: {` 与 `    key:`
const keys = new Set();
let cur = null;
for (const line of src.split("\n")) {
  const b = line.match(/^ {2}(\w+): \{/);
  if (b) {
    cur = b[1];
    continue;
  }
  const k = line.match(/^ {4}(\w+):/);
  if (k && cur) keys.add(`${cur}.${k[1]}`);
}

// 收集源码里 t("x.y") 的引用
const used = new Set();
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(vue|ts)$/.test(e.name)) {
      const s = fs.readFileSync(p, "utf8");
      for (const m of s.matchAll(/\bt\(\s*"([\w.]+)"/g)) used.add(m[1]);
    }
  }
}
walk(root);

const missing = [...used].filter((u) => !keys.has(u)).sort();
const unused = [...keys].filter((k) => !used.has(k)).sort();
console.log("定义键数:", keys.size, " 引用键数:", used.size);
console.log("\n缺失（模板引用但未定义）:", missing.length ? missing : "无");
console.log("\n未被引用（可能可清理）:", unused.length ? unused : "无");
