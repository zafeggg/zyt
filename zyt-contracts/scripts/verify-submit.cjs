/**
 * bscscan 验证提交（2026-09-26，curl 方式绕开 undici 代理 502）
 *
 * 背景：hardhat-verify 内置 undici ProxyAgent 走 CONNECT 隧道被本机代理拒（502），
 *       而 curl 经同一代理访问 api.etherscan.io 实测可用，故 HTTP 层全部改用 curl。
 *
 * 用法：node scripts/verify-submit.cjs [--only ContractName]
 * 前置：node scripts/verify-prepare.cjs 已生成 verify-json/
 * 说明：
 *   - 提交端点 verifysourcecontract 属 Etherscan 明确豁免免费层的接口（2025-11-24 公告）
 *   - 逐合约：POST 提交 → 轮询 checkverifystatus（最多 90 秒）
 *   - 失败会打印 Etherscan 返回的原始信息（常见：源码不匹配 / 已 verify / 依赖未验证）
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const KEY = (process.env.BSCSCAN_API_KEY || "").trim();
const PROXY = process.env.VERIFY_PROXY !== undefined ? process.env.VERIFY_PROXY : "http://127.0.0.1:7890";
const API = "https://api.etherscan.io/v2/api";

const OUT = path.join(__dirname, "..", "verify-json");
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** curl 经代理 GET */
function curlGet(url) {
  const args = PROXY && PROXY !== "off" ? ["-x", PROXY] : [];
  return execFileSync(
    "curl",
    ["-s", "-m", "30", ...args, url],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
}

/** curl 经代理 POST。V2 要求 chainid/module/action 等路由参数在 URL query（body 里不识别），
 *  数据参数（sourceCode 等）留在 body（--data-urlencode 自动编码，sourceCode 从文件读避免命令行超长） */
function curlPost(query, fields) {
  const qs = new URLSearchParams(query).toString();
  const args = PROXY && PROXY !== "off" ? ["-x", PROXY] : [];
  const dataArgs = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v.startsWith("@")) dataArgs.push("--data-urlencode", `${k}@${v.slice(1)}`);
    else dataArgs.push("--data-urlencode", `${k}=${v}`);
  }
  return execFileSync(
    "curl",
    ["-s", "-m", "120", ...args, "-X", "POST", `${API}?${qs}`, ...dataArgs],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
}

(async () => {
  console.log(`代理: ${PROXY} | API: ${API}`);
  let ok = 0, fail = 0;
  const results = [];

  for (const m of manifest) {
    if (only && m.name !== only) continue;
    process.stdout.write(`\n→ ${m.name} @ ${m.address}\n   提交中...`);
    let resp;
    try {
      resp = curlPost(
        { chainid: "56", apikey: KEY, module: "contract", action: "verifysourcecontract" },
        {
          codeformat: "solidity-standard-json-input",
          contractaddress: m.address,
          contractname: m.contractName,
          compilerversion: m.compilerVersion,
          constructorArguements: "@" + path.join(OUT, m.argsFile),
          sourceCode: "@" + path.join(OUT, m.jsonFile),
        }
      );
    } catch (e) {
      console.log(`\n   ✘ 提交失败: ${String(e.message).slice(0, 120)}`);
      fail++; results.push([m.name, "提交失败", ""]);
      continue;
    }
    let j;
    try { j = JSON.parse(resp); } catch { console.log(`\n   ✘ 非法响应: ${resp.slice(0, 120)}`); fail++; results.push([m.name, "非法响应", ""]); continue; }

    if (j.status !== "1") {
      const msg = String(j.result || j.message || "").slice(0, 160);
      // 已经 verify 过的合约 Etherscan 返回 "Contract source code already verified"
      const already = /already verified/i.test(msg);
      console.log(`\n   ${already ? "⊘ 已验证过（跳过）" : "✘ 提交被拒: " + msg}`);
      results.push([m.name, already ? "already" : "rejected", msg]);
      already ? ok++ : fail++;
      continue;
    }

    const guid = j.result;
    console.log(` guid=${guid}`);
    let done = false, last = "";
    for (let i = 0; i < 9; i++) {
      await sleep(10000);
      try {
        const r2 = JSON.parse(curlGet(`${API}?chainid=56&apikey=${KEY}&module=contract&action=checkverifystatus&guid=${guid}`));
        last = String(r2.result || r2.message || "");
        console.log(`   [${i + 1}/9] ${last}`);
        if (/successfully/i.test(last)) { done = true; break; }
        if (!/pending/i.test(last)) break; // fail-fast：失败原因直接返回
      } catch (e) { console.log(`   [${i + 1}/9] 轮询异常: ${String(e.message).slice(0, 80)}`); }
    }
    if (done) { ok++; results.push([m.name, "PASS", ""]); }
    else { fail++; results.push([m.name, "fail", last.slice(0, 120)]); }
  }

  console.log(`\n════ 汇总：成功 ${ok} / 失败 ${fail} ════`);
  for (const [n, s, msg] of results) console.log(`  ${n.padEnd(22)} ${s} ${msg}`);
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results));
  process.exit(fail > 0 ? 1 : 0);
})();
