/* global ethers hre */
/**
 * @title 合约 owner 移交 W2 治理多签
 * @notice 将继承 Ownable 的 7 个合约的 owner 转移给目标地址，逐笔回读 owner() 验证。
 *         ZYTMining 无 Ownable，其权限判断为 require(msg.sender == config.owner())，
 *         随 ZYTConfig 一起生效，不在本清单内。
 *
 * @usage  DRY=1 npx hardhat run scripts/transfer-ownership.js --network bsc   # 只读预览
 *         npx hardhat run scripts/transfer-ownership.js --network bsc         # 实际执行
 *
 * @note   不可逆动作。执行前务必先跑通 post-deploy-check-mainnet.mjs 全部核对项。
 *         转移完成后 deployer 对全部合约不再具备任何管理权限，私钥可转冷备。
 *         可用 OWNER_TARGET 覆盖目标地址，用 TRANSFER_DEPLOY_FILE 指定部署记录。
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");

// W2 治理多签（Gnosis Safe，阈值 2/3，owner 集合 = 营销 M1/M2 + 技术 T1）
const DEFAULT_TARGET = "0xa67E65FA6daa80eFFEE911E042C0f5b0C8718C33";
const TARGET = (process.env.OWNER_TARGET || DEFAULT_TARGET).trim();
const DRY = process.env.DRY === "1";

// 需转移 owner 的合约（均继承 OpenZeppelin Ownable，部署时 owner = deployer）
const CONTRACTS = [
  "ZYTConfig",
  "ZYTToken",
  "ZYTPoolManager",
  "ZYTLiquidityCreator",
  "ZYTForceSell",
  "ZYTDeflation",
  "ZYTReferral",
];

const ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
];

/** 选中当前网络的部署记录（与 smoke-testnet.js 同款策略：hre 网络名优先，精确前缀 + 历史命名兜底） */
function pickDeployFile() {
  if (process.env.TRANSFER_DEPLOY_FILE) return process.env.TRANSFER_DEPLOY_FILE;
  const net = (typeof hre !== "undefined" && hre.network && hre.network.name) || process.env.HARDHAT_NETWORK || "bscTestnet";
  const prefix = net === "bsc" ? "mainnet" : net === "bscTestnet" ? "bscTestnet" : "localhost";
  try {
    const dir = path.join(__dirname, "..", "deployments");
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const exact = all.filter((f) => f.startsWith(prefix)).sort();
    if (exact.length) return `deployments/${exact[exact.length - 1]}`;
    const key = prefix === "mainnet" ? "mainnet" : "testnet";
    const loose = all.filter((f) => f.includes(key)).sort();
    if (loose.length) return `deployments/${loose[loose.length - 1]}`;
  } catch {
    /* 目录缺失时落到 env 地址 */
  }
  return "";
}

async function main() {
  const file = pickDeployFile();
  if (!file) throw new Error("未找到部署记录，请用 TRANSFER_DEPLOY_FILE 指定");
  const rec = JSON.parse(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
  const addr = rec.contracts || {};

  const [signer] = await ethers.getSigners();
  console.log("===== OWNER 移交 =====");
  console.log("网络        :", hre.network.name, "chainId", rec.chainId);
  console.log("部署记录    :", file, `(version ${rec.version || "-"})`);
  console.log("执行账户    :", signer.address);
  console.log("目标 owner  :", TARGET);
  console.log("模式        :", DRY ? "DRY（只读，不发交易）" : "执行（不可逆）");
  console.log("");

  // ---------- 前置检查：执行账户必须是所有合约的当前 owner ----------
  const rows = [];
  const blocked = [];
  for (const name of CONTRACTS) {
    const a = addr[name];
    if (!a) {
      rows.push([name, "(缺失)", "跳过：部署记录无此地址"]);
      blocked.push(name);
      continue;
    }
    const c = new ethers.Contract(a, ABI, signer);
    let cur;
    try {
      cur = await c.owner();
    } catch (e) {
      rows.push([name, "(读取失败)", "跳过：" + String(e.message).slice(0, 40)]);
      blocked.push(name);
      continue;
    }
    if (cur.toLowerCase() === TARGET.toLowerCase()) {
      rows.push([name, cur, "已是目标，无需转移"]);
    } else if (cur.toLowerCase() !== signer.address.toLowerCase()) {
      rows.push([name, cur, "阻断：当前 owner 非执行账户"]);
      blocked.push(name);
    } else {
      rows.push([name, cur, "待转移"]);
    }
  }

  const w = Math.max(...rows.map((r) => r[0].length)) + 2;
  for (const [name, cur, state] of rows) {
    console.log(name.padEnd(w), cur.padEnd(44), state);
  }
  console.log("");

  if (blocked.length) {
    console.error(`❌ 中止：以下合约无法由本账户转移 → ${blocked.join(", ")}`);
    console.error("   请确认部署记录的地址正确、且当前 owner 仍是执行账户。");
    process.exit(1);
  }
  if (DRY) {
    console.log("DRY 模式：以上为预览，未发送任何交易。去掉 DRY=1 即执行。");
    return;
  }

  // ---------- 逐笔转移并回读验证 ----------
  let ok = 0;
  for (const name of CONTRACTS) {
    const a = addr[name];
    const c = new ethers.Contract(a, ABI, signer);
    const before = await c.owner();
    if (before.toLowerCase() === TARGET.toLowerCase()) {
      console.log(`- ${name} 已是目标，跳过`);
      ok++;
      continue;
    }
    process.stdout.write(`${name}  ${a}  发送中 ... `);
    const tx = await c.transferOwnership(TARGET);
    await tx.wait();
    const after = await c.owner();
    if (after.toLowerCase() !== TARGET.toLowerCase()) {
      console.error(`\n❌ ${name} 转移后 owner = ${after}，未达目标，已中止`);
      console.error("   已完成的合约不会自动回滚，需人工核对后继续。");
      process.exit(1);
    }
    console.log(`✅ tx ${tx.hash}`);
    ok++;
  }

  console.log(`\n===== 完成 ${ok}/${CONTRACTS.length} =====`);
  console.log("⚠️ ZYTMining 无独立 owner，其管理权限随 ZYTConfig 一并归属 " + TARGET);
  console.log("⚠️ 以下操作今后须由多签发起：setUint / setAddress / pause / setWhiteList /");
  console.log("   setLocker / setPaused / setKeeper / withdrawLp（若启用）");
  console.log("⚠️ deployer 已无管理权限，私钥可转冷备，不再联网。");
}

main().catch((e) => {
  console.error("ERROR:", (e && e.message) || e);
  process.exitCode = 1;
});
