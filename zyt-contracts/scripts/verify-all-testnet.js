/* global ethers hre */
/**
 * @title bscscan 批量源码验证（testnet 第九套 v9 部署，2026-09-24）
 * @notice 按依赖顺序验证 9 合约（8 业务合约 + ZYTCompute 库）；需 .env 配置 BSCSCAN_API_KEY
 * @usage  npx hardhat run scripts/verify-all-testnet.js --network bscTestnet
 * @note   验证顺序要求：库 → 无依赖合约 → 有依赖合约（bscscan 需先有依赖源码）
 * @note   v9：无 GST；新增 ZYTLiquidityCreator；PoolManager 构造参数 4→3
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
// PancakeSwap V2 testnet Factory（deploy.js 同款默认；Creator 构造参数引用）
const FACTORY_TESTNET = "0xB7926C0430Afb07AA7DEfDE6DA862aE0Bde767bc";

// 第九套 v9 部署地址（2026-09-24，USDT_MOCK=1 试运行口径）
const ADDR = {
  config: "0x27DC45A43155b456004BeB8ae589700137eEaf66",
  zyt: "0x18F532982192ED4b935f9c61F57f58d47E06b749",
  creator: "0xb63CECaF95B684F0b376B09a186303f4B38E9371",
  pool: "0x697730106294b1cbc0CB360bF539927A2c01F2f1",
  referral: "0xf6560a0f9b5d3E9d48c03f08Ca77F2763C996d97",
  forceSell: "0xA5eA6d2342B1A1B5Ea6723178F1e95ca009e056f",
  compute: "0x7D9cF4911DD3D0609D85B5a86059d608f8c8A837",
  mining: "0x29118AC2195338342d93241CBd8Bb2A8034D821e",
  deflation: "0xeC6aE4f4C3ec25d6837df8501cC7A8Aec850C291",
  usdt: "0x741e1A81E6fc2878B52694b742BA2869a736dE47",
};

// 按依赖顺序排列的验证清单（构造参数来自 deploy.js v9）
const TASKS = [
  // 1. 库（必须先验证，供 ZYTMining 引用）
  { name: "ZYTCompute", addr: ADDR.compute, args: [] },
  // 2. 无依赖
  { name: "ZYTConfig", addr: ADDR.config, args: [] },
  { name: "ZYTToken", addr: ADDR.zyt, args: [BLACK_HOLE] },
  { name: "ZYTReferral", addr: ADDR.referral, args: [] },
  // 3. 单依赖
  { name: "ZYTForceSell", addr: ADDR.forceSell, args: [ADDR.zyt] },
  {
    name: "ZYTLiquidityCreator",
    addr: ADDR.creator,
    args: [ADDR.zyt, ADDR.usdt, FACTORY_TESTNET, BLACK_HOLE],
  },
  { name: "ZYTPoolManager", addr: ADDR.pool, args: [ADDR.config, ADDR.zyt, ADDR.usdt] },
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
