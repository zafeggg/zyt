// SPDX-License-Identifier: MIT
/**
 * @notice 主网部署私钥 keystore 生成器（服务器零持有原则）
 *
 * 产出：ethers v6 keystore JSON（scrypt N=131072 + AES-128-CTR + MAC 完整性校验）
 * 服务器不存放部署/owner 私钥；本文件生成的 keystore 仅存本地/加密 U 盘/离线机。
 *
 * 用法：
 *   node scripts/gen-deployer-keystore.mjs --generate [--out deployer-mainnet.keystore.json]
 *       生成全新钱包（推荐主网用，与 testnet 钱包隔离）
 *   node scripts/gen-deployer-keystore.mjs --import [--out ...]
 *       导入已有私钥（隐藏输入，不回显、不落盘明文）
 *
 * 安全要点：
 *   1. 密码 20 位以上随机组合，纸质抄录与 keystore 分地保存（Ownable 无恢复机制）
 *   2. 生成后自校验：解密回读比对地址，防止密码输入失误产出不可用文件
 *   3. 全程内存操作，明文私钥不写入任何文件、不打印到终端
 */
import { Wallet } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { promptHidden, closePrompt } = require("./lib/hidden-input.js");

const args = process.argv.slice(2);
const generate = args.includes("--generate");
const outIdx = args.indexOf("--out");
const outPath = path.resolve(outIdx >= 0 ? args[outIdx + 1] : "deployer-mainnet.keystore.json");

async function promptPassword(twice = true) {
  const p1 = await promptHidden("设置 keystore 密码（20 位以上随机组合）: ");
  if (p1.length < 20) throw new Error("密码过短（<20 位）：弱密码会在 keystore 泄露时被爆破");
  if (!twice) return p1;
  const p2 = await promptHidden("再次输入密码确认: ");
  if (p1 !== p2) throw new Error("两次密码不一致");
  return p1;
}

async function main() {
  let wallet;
  if (generate) {
    wallet = Wallet.createRandom();
    console.log("已生成全新钱包（助记词请立即纸质抄录并分地保存，本程序不会打印助记词到日志）:");
  } else {
    const pk = await promptHidden("输入部署私钥（0x 开头，隐藏输入）: ");
    wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  }
  const password = await promptPassword();

  // scrypt 高参数加密（ethers 默认 N=131072/r=8/p=1，即 Web3 Secret Storage 标准）
  const json = await wallet.encrypt(password);

  // 自校验：解密回读，地址一致才落盘（防密码失误产出不可恢复的文件）
  const roundTrip = await Wallet.fromEncryptedJson(json, password);
  if (roundTrip.address.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error("自校验失败：解密回读地址不一致（不应发生，请检查环境）");
  }

  fs.writeFileSync(outPath, json, { encoding: "utf8", mode: 0o600 });
  console.log("\n===== KEYSTORE 已生成 =====");
  console.log("文件      :", outPath);
  console.log("钱包地址  :", wallet.address);
  console.log("加密参数  : scrypt N=131072 + AES-128-CTR + MAC");
  console.log("\n后续动作:");
  console.log("1. keystore 文件移入加密 U 盘/离线机，本地不留副本");
  console.log("2. 密码 + 助记词纸质抄录分地保存（Ownable 无恢复，备份丢失=合约永久失控）");
  console.log("3. 主网部署: MAINNET_KEYSTORE=<路径> npx hardhat run scripts/deploy.js --network bsc");
  if (generate) {
    console.log("4. 私钥/助记词仅存于本次运行内存，如需再次导出请重新 --generate（推荐直接用助记词恢复）");
  }
  closePrompt();
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
