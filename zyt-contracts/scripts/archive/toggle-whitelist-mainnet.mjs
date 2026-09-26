/**
 * 主网买入白名单全局开关 + 名单管理（owner = deployer 0xB723）
 *
 * 用法（在 zyt-contracts 目录执行，需 .env PRIVATE_KEY；建议加 BSC_MAINNET_RPC 指定官方节点）：
 *   node scripts/toggle-whitelist-mainnet.mjs status                    # 查看当前开关状态
 *   node scripts/toggle-whitelist-mainnet.mjs off                       # 关闭全局开关（人人可买，试运行期用）
 *   node scripts/toggle-whitelist-mainnet.mjs on                        # 开启全局开关（主网上线前必开）
 *   node scripts/toggle-whitelist-mainnet.mjs add   0x地址A 0x地址B...   # 批量加入白名单
 *   node scripts/toggle-whitelist-mainnet.mjs remove 0x地址A 0x地址B...   # 批量移出白名单
 *
 * 语义（v7 决策 15）：
 *   - buyWhitelistEnabled = true  → 仅白名单地址可入金/买入（主网上线前必须开启，防闪电贷）
 *   - buyWhitelistEnabled = false → 逃生通道：人人可买（仅测试期）
 */
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import "dotenv/config";

const CONFIG = "0x7247791Bd79e831C78B8DCFDF820C43a7386f370";
const POOL = "0xe2b0DdB48f4455830D38cD765d9b79DBd906c291";
const RPC = process.env.BSC_MAINNET_RPC || "https://bsc-dataseed1.bnbchain.org";

const p = new JsonRpcProvider(RPC, 56, { staticNetwork: true });
const owner = new Wallet(process.env.PRIVATE_KEY, p);
const cfg = new Contract(
  CONFIG,
  [
    "function buyWhitelistEnabled() view returns (bool)",
    "function setBuyWhitelistEnabled(bool)",
    "function marketAddress() view returns (address)",
    "function technicalAddress() view returns (address)",
  ],
  owner
);
const pool = new Contract(
  POOL,
  [
    "function buyWhitelist(address) view returns (bool)",
    "function setBuyWhitelist(address,bool)",
    "function setBuyWhitelistBatch(address[] calldata,bool)",
  ],
  owner
);

const cmd = (process.argv[2] || "status").toLowerCase();
const addrs = process.argv.slice(3).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));

async function showStatus() {
  const [enabled, market, tech] = await Promise.all([
    cfg.buyWhitelistEnabled(),
    cfg.marketAddress(),
    cfg.technicalAddress(),
  ]);
  console.log("=== 主网买入白名单状态 ===");
  console.log("全局开关 buyWhitelistEnabled :", enabled, enabled ? "（仅白名单可买）" : "（人人可买，测试期逃生通道）");
  console.log("MARKET 地址（豁免）          :", market);
  console.log("TECHNICAL 地址（豁免）       :", tech);
  console.log("配置                             :", CONFIG, "| owner:", owner.address);
}

if (cmd === "status") {
  await showStatus();
} else if (cmd === "off" || cmd === "on") {
  const target = cmd === "on";
  const cur = await cfg.buyWhitelistEnabled();
  if (cur === target) {
    console.log("已是目标状态（" + cur + "），无需操作");
  } else {
    const tx = await cfg.setBuyWhitelistEnabled(target);
    await tx.wait();
    console.log("✔ setBuyWhitelistEnabled(" + target + ")  tx=" + tx.hash);
  }
  await showStatus();
} else if (cmd === "add" || cmd === "remove") {
  if (!addrs.length) {
    console.error("用法: node scripts/toggle-whitelist-mainnet.mjs add|remove 0x地址 [更多地址...]");
    process.exit(1);
  }
  const flag = cmd === "add";
  console.log("批量" + (flag ? "加入" : "移出") + "白名单 " + addrs.length + " 个地址...");
  // 先打印变更前状态，便于核对
  for (const a of addrs) console.log("  " + a + " 当前:", await pool.buyWhitelist(a));
  const tx = await pool.setBuyWhitelistBatch(addrs, flag);
  await tx.wait();
  console.log("✔ setBuyWhitelistBatch(" + addrs.length + ", " + flag + ")  tx=" + tx.hash);
  for (const a of addrs) console.log("  " + a + " 现在:", await pool.buyWhitelist(a));
  await showStatus();
} else {
  console.error("未知命令:", cmd, "（可用: status | off | on | add | remove）");
  process.exit(1);
}
process.exit(0);
