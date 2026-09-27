// SPDX-License-Identifier: MIT
/* global hre */
/**
 * @notice owner 私钥离线签名工具（hardhat task：build → sign → send 三步流）
 *
 * 服务器零持有原则：部署/owner 私钥永不进入联网服务器。
 *   ① build（联网机）  构造未签名交易 → tx-logs/unsigned-tx-<ts>.json
 *   ② sign（离线机）   keystore 解密签名 → tx-logs/signed-tx-<ts>.json（密码隐藏输入）
 *   ③ send（联网机）   广播已签名交易 → 等待确认
 *
 * 用法示例（更换 keeper 地址）：
 *   npx hardhat owner-tx --cmd build --artifact ZYTConfig --to 0xCONFIG \
 *       --fn setAddress --args keeperAddress,0xNEWKEEPER --from 0xOWNER --network bsc
 *   npx hardhat owner-tx --cmd sign --keystore deployer-mainnet.keystore.json \
 *       --unsigned tx-logs/unsigned-tx-xxx.json
 *   npx hardhat owner-tx --cmd send --signed tx-logs/signed-tx-xxx.json --network bsc
 *
 * 留档：tx-logs/owner-tx-<ts>.json 记录三态（已 gitignore），操作可审计。
 */
const { task } = require("hardhat/config");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { promptHidden, closePrompt } = require("../scripts/lib/hidden-input.js");

const TX_LOG_DIR = path.join(__dirname, "..", "tx-logs");

/** ABI 参数智能转换：0x 原样 / 纯数字→BigInt / true,false→bool / 其它→字符串 */
function coerceArg(s) {
  if (/^0x[0-9a-fA-F]+$/.test(s)) return s;
  if (/^-?\d+$/.test(s)) return BigInt(s);
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + (Date.now() % 10000);
}

function archive(stage, payload) {
  fs.mkdirSync(TX_LOG_DIR, { recursive: true });
  const file = path.join(TX_LOG_DIR, `owner-tx-${payload.ts}.json`);
  let log = {};
  if (fs.existsSync(file)) log = JSON.parse(fs.readFileSync(file, "utf8"));
  log[stage] = payload;
  fs.writeFileSync(file, JSON.stringify(log, null, 2));
  return file;
}

async function cmdBuild(a) {
  if (!a.artifact || !a.to || !a.fn || !a.from) {
    throw new Error("build 需要 --artifact <合约名> --to <地址> --fn <方法> --from <owner地址>，可选 --args v1,v2 --value 0 --nonce n --gas-limit n");
  }
  const artifact = await hre.artifacts.readArtifact(a.artifact);
  const iface = new ethers.Interface(artifact.abi);
  const args = (a.args ? a.args.split(",").map((s) => s.trim()) : []).map(coerceArg);
  const data = iface.encodeFunctionData(a.fn, args);
  const provider = hre.network.name === "hardhat" ? null : hre.ethers.provider;
  if (!provider && a.nonce === undefined) {
    throw new Error("build 需要联网查 nonce：请加 --network bsc（或显式 --nonce 离线构造）");
  }
  const nonce = a.nonce !== undefined ? Number(a.nonce) : await provider.getTransactionCount(a.from);
  const chainId = provider ? (await provider.getNetwork()).chainId : 31337n;
  let gasLimit = a.gasLimit ? BigInt(a.gasLimit) : null;
  let gasPrice = a.gasPrice ? BigInt(a.gasPrice) : null;
  if ((!gasLimit || !gasPrice) && provider) {
    // 联网机估算（from 仅作模拟身份，无需私钥）；legacy gasPrice 型交易 BSC 主网通用
    if (!gasLimit) {
      gasLimit = await provider
        .estimateGas({ from: a.from, to: a.to, data, value: a.value || 0 })
        .catch(() => null);
      if (!gasLimit) throw new Error("estimateGas 失败：检查 --from 是否为当前 owner、参数是否正确（合约可能 revert）");
    }
    if (!gasPrice) gasPrice = await provider.getGasPrice();
  }
  if (!gasLimit || !gasPrice) throw new Error("离线 build 必须显式 --gas-limit 与 --gas-price");
  const unsigned = {
    ts: stamp(), stage: "build", artifact: a.artifact, fn: a.fn, args: a.args || "",
    from: a.from,
    tx: { to: a.to, data, nonce, chainId: Number(chainId), gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), value: (a.value || "0").toString() },
  };
  const file = path.join(TX_LOG_DIR, `unsigned-tx-${unsigned.ts}.json`);
  fs.mkdirSync(TX_LOG_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(unsigned, null, 2));
  console.log("未签名交易:", file);
  console.log(JSON.stringify(unsigned.tx, null, 2));
  archive("build", unsigned);
  console.log(`\n下一步（离线机）: npx hardhat owner-tx --cmd sign --keystore <ks路径> --unsigned ${path.basename(file)}`);
}

async function cmdSign(a) {
  if (!a.keystore || !a.unsigned) throw new Error("sign 需要 --keystore <路径> --unsigned <文件>");
  const unsigned = JSON.parse(fs.readFileSync(a.unsigned, "utf8"));
  const json = fs.readFileSync(path.resolve(a.keystore), "utf8");
  const password = process.env.MAINNET_KEYSTORE_PASSWORD || (await promptHidden("keystore 密码: "));
  closePrompt();
  // 纯本地解密签名（MAC 校验失败=密码错误），无网络请求
  const wallet = await ethers.Wallet.fromEncryptedJson(json, password);
  if (unsigned.from && wallet.address.toLowerCase() !== unsigned.from.toLowerCase()) {
    throw new Error(`keystore 地址 ${wallet.address} 与 build 时 --from ${unsigned.from} 不一致`);
  }
  const signed = await wallet.signTransaction({
    to: unsigned.tx.to, data: unsigned.tx.data, nonce: unsigned.tx.nonce,
    chainId: unsigned.tx.chainId, gasLimit: unsigned.tx.gasLimit, gasPrice: unsigned.tx.gasPrice, value: unsigned.tx.value,
  });
  const out = { ts: unsigned.ts, stage: "sign", signer: wallet.address, signed };
  const file = path.join(TX_LOG_DIR, `signed-tx-${unsigned.ts}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("已签名交易:", file);
  archive("sign", out);
  console.log(`\n下一步（联网机）: npx hardhat owner-tx --cmd send --signed ${path.basename(file)} --network bsc`);
}

async function cmdSend(a) {
  if (!a.signed) throw new Error("send 需要 --signed <文件>（配 --network bsc 广播）");
  const rec = JSON.parse(fs.readFileSync(a.signed, "utf8"));
  const provider = hre.ethers.provider;
  const sent = await provider.broadcastTransaction(rec.signed);
  console.log("tx hash:", sent.hash, "等待确认...");
  const receipt = await sent.wait();
  console.log(`已确认 block=${receipt.blockNumber} status=${receipt.status === 1 ? "成功" : "失败"}`);
  archive("send", { ts: rec.ts, stage: "send", hash: sent.hash, block: receipt.blockNumber, status: receipt.status });
}

task("owner-tx", "owner 私钥离线签名工具（build/sign/send 三步流，服务器零持有）")
  .addParam("cmd", "子命令：build | sign | send")
  .addOptionalParam("artifact", "合约名（artifacts 中的 artifact 名，如 ZYTConfig）")
  .addOptionalParam("to", "目标合约地址")
  .addOptionalParam("fn", "要调用的方法名")
  .addOptionalParam("args", "方法参数（逗号分隔，如 keeperAddress,0xABC）")
  .addOptionalParam("from", "owner 地址（build 时查 nonce/估算 gas、sign 时一致性校验）")
  .addOptionalParam("value", "附带 ETH（wei 字符串，默认 0）")
  .addOptionalParam("nonce", "显式 nonce（离线 build 用）")
  .addOptionalParam("gasLimit", "显式 gas limit（离线 build 用）")
  .addOptionalParam("gasPrice", "显式 gas price（wei，离线 build 用）")
  .addOptionalParam("keystore", "keystore 文件路径（sign）")
  .addOptionalParam("unsigned", "未签名交易文件（sign）")
  .addOptionalParam("signed", "已签名交易文件（send）")
  .setAction(async (a) => {
    if (a.cmd === "build") return cmdBuild(a);
    if (a.cmd === "sign") return cmdSign(a);
    if (a.cmd === "send") return cmdSend(a);
    throw new Error(`未知 --cmd: ${a.cmd}（可选 build | sign | send）`);
  });

module.exports = {};
