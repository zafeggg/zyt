/* global ethers */
/**
 * ZYTConfig owner 移交脚本（仅移交 ZYTConfig，其余合约保持不动）
 *
 * 背景与策略：
 *   - 正式版上线时，ZYTConfig 的 owner 移交给 W2 治理多签（Gnosis Safe 2/3）
 *   - 只移交 ZYTConfig 的理由：调参权限（setUint / setAddress）归多签治理，
 *     同时把入金、卖出、通缩等业务合约的紧急操作权暂时留在部署钱包，便于运营初期快速响应
 *   - transferOwnership 单向不可逆，执行前请再次确认目标地址
 *
 * 用法：
 *   node scripts/transfer-config-owner.js --show                    # 只读：打印当前 owner 并校验目标
 *   node scripts/transfer-config-owner.js                           # 测试链执行（交互确认）
 *   node scripts/transfer-config-owner.js --chain mainnet           # 主网执行（交互确认）
 *   node scripts/transfer-config-owner.js --to 0x... --yes          # 指定目标并跳过确认（谨慎）
 *   node scripts/transfer-config-owner.js --config 0x...            # 指定 Config 地址
 *   node scripts/transfer-config-owner.js --rpc https://...         # 覆盖 RPC（.env 里的官方节点在部分网络不可达）
 *
 * 前置：
 *   - .env 的 PRIVATE_KEY 必须是 ZYTConfig 的当前 owner
 *   - .env 的 GOVERNANCE_ADDRESS 为目标多签（可用 --to 覆盖）
 *   - .env 的 BSC_TESTNET_RPC / BSC_MAINNET_RPC 可用
 *
 * 安全设计：
 *   - 目标地址必须是有代码的合约且 getThreshold() 可调用，防止误传给 EOA
 *   - 校验签名钱包与链上 owner 一致，避免用错钱包白付 gas
 *   - 二次确认（输入 yes），执行后读回 owner() 复核
 *   - 移交成功后提示：后续调参需走 Safe 提案，本脚本与 set-deposit-range.js 不再可用
 */
require("dotenv").config();
const readline = require("readline");
const { JsonRpcProvider, Wallet, Contract, getAddress, formatEther } = require("ethers");

const args = process.argv.slice(2);
const showOnly = args.includes("--show");
const autoYes = args.includes("--yes");
const chainName = args.includes("--chain") ? String(args[args.indexOf("--chain") + 1] || "").toLowerCase() : "testnet";
const toArg = args.includes("--to") ? args[args.indexOf("--to") + 1] : null;
const cfgArg = args.includes("--config") ? args[args.indexOf("--config") + 1] : null;
const rpcArg = args.includes("--rpc") ? args[args.indexOf("--rpc") + 1] : null;

const NETS = {
  testnet: {
    label: "BSC 测试链",
    id: 97,
    rpc: process.env.BSC_TESTNET_RPC || "https://bsc-testnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3",
    defaultCfg: "0x8402D46f5974301028Ee461d485748b71b0dc487", // v9.1 第十套
  },
  mainnet: {
    label: "BSC 主网",
    id: 56,
    rpc: process.env.BSC_MAINNET_RPC || "https://bsc.blockrazor.xyz",
    defaultCfg: "0x7247791Bd79e831C78B8DCFDF820C43a7386f370", // 试运行版 v8
  },
};

const CONFIG_ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
];
const SAFE_ABI = [
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
];

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim().toLowerCase()); }));
}

async function main() {
  const net = NETS[chainName];
  if (!net) {
    console.error("❌ --chain 只支持 testnet 或 mainnet");
    process.exit(1);
  }
  const configAddr = cfgArg ? getAddress(cfgArg) : net.defaultCfg;
  const target = getAddress(toArg || process.env.GOVERNANCE_ADDRESS || "");
  const rpc = rpcArg || net.rpc;
  const provider = new JsonRpcProvider(rpc, net.id, { staticNetwork: true });

  console.log("网络      :", net.label, "chainId", net.id);
  console.log("RPC       :", rpc, rpcArg ? "(--rpc 指定)" : "");
  console.log("Config    :", configAddr);
  console.log("移交目标  :", target, toArg ? "(--to 指定)" : "(来自 .env GOVERNANCE_ADDRESS)");

  // ---- 1. Config 合约与当前 owner ----
  if ((await provider.getCode(configAddr)) === "0x") {
    console.error("❌ Config 地址没有合约代码，请检查网络与地址");
    process.exit(1);
  }
  const cfgRead = new Contract(configAddr, CONFIG_ABI, provider);
  const owner = await cfgRead.owner();
  console.log("当前 owner:", owner);

  // ---- 2. 目标地址校验（必须是 Safe 多签）----
  if ((await provider.getCode(target)) === "0x") {
    console.error("❌ 目标地址没有合约代码（疑似 EOA），拒绝移交");
    process.exit(1);
  }
  let threshold = 0n;
  let ownersList = [];
  try {
    const safe = new Contract(target, SAFE_ABI, provider);
    threshold = BigInt(await safe.getThreshold());
    ownersList = await safe.getOwners();
  } catch (e) {
    console.error("❌ 目标地址不是 Gnosis Safe（getThreshold/getOwners 调用失败），拒绝移交");
    console.error("   原因:", String(e.message).slice(0, 120));
    process.exit(1);
  }
  if (threshold <= 0n) {
    console.error("❌ Safe 阈值异常（0），拒绝移交");
    process.exit(1);
  }
  console.log("目标属性  : Gnosis Safe，阈值", threshold.toString() + "/" + ownersList.length);
  ownersList.forEach((o, i) => console.log("            signer" + (i + 1) + ":", o));

  // ---- 3. 前置一致性检查 ----
  if (owner.toLowerCase() === target.toLowerCase()) {
    console.log("\n✅ owner 已经是该多签，无需移交（幂等）");
    return;
  }
  if (owner.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    console.error("❌ 当前 owner 为零地址（合约可能未初始化），拒绝执行");
    process.exit(1);
  }

  if (showOnly) {
    console.log("\n（只读模式，未做任何改动）");
    console.log("执行移交请去掉 --show，例如：node scripts/transfer-config-owner.js --chain " + chainName);
    return;
  }

  // ---- 4. 签名钱包校验 ----
  const pk = process.env.PRIVATE_KEY;
  if (!pk || !pk.trim()) {
    console.error("❌ .env 缺少 PRIVATE_KEY");
    process.exit(1);
  }
  const wallet = new Wallet(pk.trim(), provider);
  if (wallet.address.toLowerCase() !== owner.toLowerCase()) {
    console.error(`❌ 私钥地址 ${wallet.address} 与当前 owner ${owner} 不一致，无法执行`);
    process.exit(1);
  }
  const bnb = await provider.getBalance(wallet.address);
  console.log("\n执行钱包  :", wallet.address, "| BNB", formatEther(bnb));
  if (bnb === 0n) {
    console.error("❌ 执行钱包 BNB 余额为 0，无法支付 gas");
    process.exit(1);
  }

  // ---- 5. 改动预览与确认 ----
  console.log("\n即将执行（不可逆）：");
  console.log("  合约        : ZYTConfig", configAddr);
  console.log("  owner       : " + owner + "  ->  " + target);
  console.log("  影响        : 调参（setUint/setAddress）与暂停权移交多签，部署钱包立即失去该权限");
  console.log("  不受影响    : Mining / Pool / ZYTToken / Deflation / ForceSell / Referral / Creator");
  if (!autoYes) {
    const a = await ask("确认执行请输入 yes：");
    if (a !== "yes") {
      console.log("已取消，未做任何改动");
      return;
    }
  }

  // ---- 6. 发送交易 ----
  const cfg = new Contract(configAddr, CONFIG_ABI, wallet);
  process.stdout.write("发送 transferOwnership ... ");
  const tx = await cfg.transferOwnership(target);
  const rc = await tx.wait();
  console.log("✅ 已上链");
  console.log("  tx hash :", tx.hash);
  console.log("  区块高度:", rc.blockNumber, "| gasUsed:", rc.gasUsed.toString());

  // ---- 7. 读回验证 ----
  const after = await cfgRead.owner();
  const ok = after.toLowerCase() === target.toLowerCase();
  console.log("\n读回验证：owner =", after, ok ? "✅ 移交成功" : "⚠️ 与预期不符，请立即检查");

  console.log("\n留档信息（建议写入部署记录与《上线操作手册》）：");
  console.log("  network     :", net.label, "(" + net.id + ")");
  console.log("  config      :", configAddr);
  console.log("  from        :", owner);
  console.log("  to          :", target);
  console.log("  txHash      :", tx.hash);
  console.log("  blockNumber :", rc.blockNumber);

  if (ok) {
    console.log("\n后续说明：");
    console.log("  1. 此后所有参数变更（起投范围、滑点、通缩率、营销比例等）需在 Safe 界面发起提案，");
    console.log("     由 " + threshold.toString() + " 位签名人确认后执行");
    console.log("  2. scripts/set-deposit-range.js 依赖 owner 私钥，移交后不可用");
    console.log("  3. 其余合约 owner 仍为部署钱包，可按计划分阶段移交");
  }
}

main().catch((e) => {
  console.error("ERROR:", String(e.message).slice(0, 300));
  process.exit(1);
});
