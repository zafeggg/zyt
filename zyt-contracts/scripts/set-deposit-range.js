/* global ethers */
/**
 * 起投金额调整脚本（minDeposit / maxDeposit 专用）
 *
 * 用法：
 *   node scripts/set-deposit-range.js --show            # 只读，打印当前起投范围
 *   node scripts/set-deposit-range.js 100 500           # 设为 100-500U（交互确认）
 *   node scripts/set-deposit-range.js 200 1000 --yes    # 跳过确认（谨慎使用）
 *
 * 前置：
 *   - .env 的 PRIVATE_KEY 必须是 ZYTConfig 的 owner
 *     试运行版 owner = W1 测试部署钱包（单签，可直接执行）
 *     正式版 owner = W2 治理多签（本脚本不可用，需走 Safe 提案签名）
 *   - .env 可覆盖 ZYT_CONFIG_ADDR 与 RPC_URL（默认试运行版地址与 blockrazor 节点）
 *
 * 安全设计：
 *   - 参数单位换算与范围断言内置，防止把 USDT 写成最小单位或误设极端值
 *   - 发交易前校验私钥地址与链上 owner 一致，避免用错钱包浪费 gas
 *   - 两笔交易（下限、上限）分别发送，逐笔确认并读回验证
 */
require("dotenv").config();
const readline = require("readline");
const { JsonRpcProvider, Wallet, Contract, keccak256, toUtf8Bytes, parseEther, formatEther } = require("ethers");

const RPC = process.env.RPC_URL || "https://bsc.blockrazor.xyz";
// 试运行版 ZYTConfig；正式版部署后请用 ZYT_CONFIG_ADDR 覆盖
const CONFIG_ADDR = process.env.ZYT_CONFIG_ADDR || "0x7247791Bd79e831C78B8DCFDF820C43a7386f370";

const ABI = [
  "function minDeposit() view returns (uint256)",
  "function maxDeposit() view returns (uint256)",
  "function owner() view returns (address)",
  "function setUint(bytes32 key, uint256 value)",
];
const KEY_MIN = keccak256(toUtf8Bytes("minDeposit"));
const KEY_MAX = keccak256(toUtf8Bytes("maxDeposit"));

// 安全边界：防止误操作把起投范围设成极端值
const LIMIT_MIN = 1; // 下限不得低于 1U
const LIMIT_MAX = 100000; // 上限不得高于 10 万 U

/** 读取当前起投范围与 owner */
async function readState(provider) {
  const cfg = new Contract(CONFIG_ADDR, ABI, provider);
  const [min, max, owner] = await Promise.all([cfg.minDeposit(), cfg.maxDeposit(), cfg.owner()]);
  return { cfg, min: formatEther(min), max: formatEther(max), owner };
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim().toLowerCase()); }));
}

async function main() {
  const args = process.argv.slice(2);
  const provider = new JsonRpcProvider(RPC, 56, { staticNetwork: true });
  const state = await readState(provider);

  console.log(`网络 RPC  : ${RPC}`);
  console.log(`Config 合约: ${CONFIG_ADDR}`);
  console.log(`owner     : ${state.owner}`);
  console.log(`当前起投  : ${state.min} U  至  ${state.max} U\n`);

  if (args.length === 0 || args.includes("--show")) {
    console.log("（只读模式，未做任何改动。调整请传入新的下限与上限，例如：node scripts/set-deposit-range.js 100 500）");
    return;
  }

  const nums = args.filter((a) => !a.startsWith("--"));
  if (nums.length !== 2) {
    console.error("❌ 需要两个数字参数：新下限 新上限。例如：node scripts/set-deposit-range.js 100 500");
    process.exit(1);
  }
  const newMin = Number(nums[0]);
  const newMax = Number(nums[1]);

  // ---- 输入校验 ----
  if (!Number.isFinite(newMin) || !Number.isFinite(newMax)) {
    console.error("❌ 参数必须是数字");
    process.exit(1);
  }
  if (newMin < LIMIT_MIN || newMax > LIMIT_MAX) {
    console.error(`❌ 超出安全边界：下限不得低于 ${LIMIT_MIN}U，上限不得高于 ${LIMIT_MAX}U`);
    process.exit(1);
  }
  if (newMin >= newMax) {
    console.error("❌ 下限必须小于上限");
    process.exit(1);
  }

  // ---- 私钥与 owner 一致性校验 ----
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error("❌ .env 缺少 PRIVATE_KEY");
    process.exit(1);
  }
  const wallet = new Wallet(pk, provider);
  if (wallet.address.toLowerCase() !== state.owner.toLowerCase()) {
    console.error(`❌ 当前私钥地址 ${wallet.address} 与 owner ${state.owner} 不一致，无法执行（正式版 owner 为多签时需走 Safe 提案）`);
    process.exit(1);
  }
  const gas = await provider.getBalance(wallet.address);
  console.log(`执行钱包  : ${wallet.address}（BNB ${formatEther(gas)}，用于支付两笔交易的 gas）`);

  // ---- 改动预览与确认 ----
  console.log(`\n即将调整：`);
  console.log(`  起投下限  ${state.min} U  ->  ${newMin} U`);
  console.log(`  起投上限  ${state.max} U  ->  ${newMax} U`);
  if ((await provider.getCode(CONFIG_ADDR)) === "0x") {
    console.error("❌ Config 地址没有合约代码，请检查网络与地址");
    process.exit(1);
  }

  if (!args.includes("--yes")) {
    const a = await ask("确认执行请输入 yes：");
    if (a !== "yes") {
      console.log("已取消，未做任何改动");
      return;
    }
  }

  // ---- 发送两笔交易 ----
  const cfg = new Contract(CONFIG_ADDR, ABI, wallet);
  const sent = [];
  for (const [label, key, val] of [
    ["起投下限", KEY_MIN, newMin],
    ["起投上限", KEY_MAX, newMax],
  ]) {
    process.stdout.write(`发送 ${label} = ${val} U ... `);
    const tx = await cfg.setUint(key, parseEther(String(val)));
    const rc = await tx.wait();
    console.log(`✅ tx=${tx.hash} gasUsed=${rc.gasUsed.toString()}`);
    sent.push({ label, hash: tx.hash });
  }

  // ---- 读回验证 ----
  const after = await readState(provider);
  console.log(`\n读回验证：起投范围 = ${after.min} U 至 ${after.max} U`);
  const ok = Number(after.min) === newMin && Number(after.max) === newMax;
  console.log(ok ? "✅ 调整成功" : "⚠️ 读回值与预期不一致，请检查");
  console.log("\n留档信息：");
  for (const s of sent) console.log(`  ${s.label}: ${s.hash}`);
}

main().catch((e) => {
  console.error("ERROR:", String(e.message).slice(0, 300));
  process.exit(1);
});
