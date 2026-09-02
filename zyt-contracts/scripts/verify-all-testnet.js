/* global ethers hre */
/**
 * @title bscscan 批量源码验证（testnet 第五套部署）
 * @notice 按依赖顺序验证 9 合约 + ZYTCompute 库；需 .env 配置 BSCSCAN_API_KEY
 * @usage  npx hardhat run scripts/verify-all-testnet.js --network bscTestnet
 * @note   验证顺序要求：库 → 无依赖合约 → 有依赖合约（bscscan 需先有依赖源码）
 */
require("dotenv").config();

// ===== 网络代理注入（国内直连 api.etherscan.io 会被阻断，V1→V2 后走统一域名） =====
// VERIFY_PROXY 默认本机 7890（Clash 类）；设 VERIFY_PROXY=off 可跳过注入。
// undici setGlobalDispatcher 影响所有 fetch（etherscan API + RPC 均走代理，实测代理对两者均连通）。
const PROXY = process.env.VERIFY_PROXY !== undefined ? process.env.VERIFY_PROXY : "http://127.0.0.1:7890";
if (PROXY && PROXY !== "off") {
  const { ProxyAgent, setGlobalDispatcher } = require("undici");
  setGlobalDispatcher(new ProxyAgent(PROXY));
  console.log(`[proxy] fetch dispatcher -> ${PROXY}`);
}

const BLACK_HOLE = "0x000000000000000000000000000000000000dEaD";

// 第五套部署地址（2026-09-01）
const ADDR = {
  config: "0x62a96b2880fD282BC0984db800057F1CDFe2873C",
  gst: "0x6E612B64885EBcd2511f97d8eC74c80fAE08FF20",
  zyt: "0x9bd8CD99e61BE9c1FbB35282345111017a80F107",
  forceSell: "0x519F2179C5Fbe481034BE663C07e04b692fA6D78",
  pool: "0x701A4A0cF59a05ada702e9b8b572b46e50F70726",
  referral: "0xC6666DB4Ee72eC9485664fa2D67113e4BE888a86",
  compute: "0x2bC41F23DD198E2e6DF5cDd2786b2b1E3e4d19A9",
  mining: "0x3A7B648752D3557C9770a56Fd3B471dB6ee8FE69",
  deflation: "0xED866239D6Fcd7164C54b3431f745850fACc60c1",
  usdt: "0xe6d5879149078B7082567AF70319a16b7952CA8C",
};

// 按依赖顺序排列的验证清单（构造参数来自 deploy.js）
const TASKS = [
  // 1. 库（必须先验证，供 ZYTMining 引用）
  { name: "ZYTCompute", addr: ADDR.compute, args: [] },
  // 2. 无依赖
  { name: "ZYTConfig", addr: ADDR.config, args: [] },
  { name: "GSTToken", addr: ADDR.gst, args: [BLACK_HOLE] },
  { name: "ZYTToken", addr: ADDR.zyt, args: [BLACK_HOLE] },
  { name: "ZYTReferral", addr: ADDR.referral, args: [] },
  // 3. 单依赖
  { name: "ZYTForceSell", addr: ADDR.forceSell, args: [ADDR.zyt] },
  { name: "ZYTPoolManager", addr: ADDR.pool, args: [ADDR.config, ADDR.zyt, ADDR.usdt, ADDR.gst] },
  // 4. 多依赖 + 库链接（ZYTCompute 定义在独立文件 contracts/ZYTCompute.sol，全限定名必须带正确文件路径）
  {
    name: "ZYTMining",
    addr: ADDR.mining,
    args: [ADDR.config, ADDR.pool, ADDR.referral, ADDR.zyt, ADDR.usdt],
    libraries: { "contracts/ZYTCompute.sol:ZYTCompute": ADDR.compute },
  },
  { name: "ZYTDeflation", addr: ADDR.deflation, args: [ADDR.config, ADDR.pool, ADDR.mining] },
];

async function main() {
  if (!process.env.BSCSCAN_API_KEY) {
    console.error("❌ 缺少 BSCSCAN_API_KEY（.env 中为空），请先配置后再运行");
    process.exit(1);
  }
  let ok = 0,
    fail = 0;
  for (const t of TASKS) {
    process.stdout.write(`验证 ${t.name} @ ${t.addr} ... `);
    try {
      await hre.run("verify:verify", {
        address: t.addr,
        constructorArguments: t.args,
        libraries: t.libraries || {},
      });
      console.log("✅");
      ok++;
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes("Already Verified")) {
        console.log("✅（已验证过）");
        ok++;
      } else {
        console.log("❌ " + msg.slice(0, 200));
        fail++;
      }
    }
    // bscscan 免费 API 限速：每次请求间等待 2s
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`\n=== 验证完成：成功 ${ok} / 失败 ${fail}（共 ${TASKS.length}）===`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("ERROR:", e.message.slice(0, 400));
  process.exit(1);
});
