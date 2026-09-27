/* global ethers hre */
/**
 * @title bscscan 批量源码验证（主网 TestUSDT 试运行版，2026-09-14）
 * @notice 按依赖顺序验证 9 合约 + ZYTCompute 库 + TestUSDT；需 .env 配置 BSCSCAN_API_KEY
 * @usage  npx hardhat run scripts/verify-all-mainnet.js --network bsc
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

// 主网 TestUSDT 试运行版（2026-09-14，deployments/mainnet-test-20260914.json）
const ADDR = {
  config: "0x7247791Bd79e831C78B8DCFDF820C43a7386f370",
  gst: "0x3D4A87Bb1487737b97BD4c86a56EDCA9f794F784",
  zyt: "0xAB4c090CD436D1d93Aa6D18067A3217206Bd097A",
  forceSell: "0xD944f0A514b92F9adBc805F7E94E75aD489Af2A6",
  pool: "0xe2b0DdB48f4455830D38cD765d9b79DBd906c291",
  referral: "0x74285fC2c76F1C5Ec1912bA6EB2788B353C26970",
  compute: "0x740d83b9b64dFb21Df7C1BD11B3Fa213Fe09400b",
  mining: "0xFC97Bf17243C2ef9A8442c190A1897B61745C830",
  deflation: "0x95e60944e0DF1846f5498B4b8A678564f9aCDe26",
  usdt: "0x4cd6d10260Cdfc55A9dcf97dfffade73080E7608",
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
  // 5. TestUSDT（MockERC20，主网试运行专用）
  { name: "contracts/mocks/MockERC20.sol:MockERC20", addr: ADDR.usdt, args: ["Mock USDT", "USDT", 18] },
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
