/* global ethers */
/**
 * @title 探针：对比线上合约字节码 vs 本地 artifacts 部署字节码，判定版本一致性
 * @usage  npx hardhat run scripts/probe-bytecode.js --network bscTestnet
 */
const { ethers } = require("hardhat");
require("dotenv").config();
const fs = require("fs");

const ADDRS = {
  ZYTMining: "0x3A7B648752D3557C9770a56Fd3B471dB6ee8FE69",
  ZYTPoolManager: "0x701A4A0cF59a05ada702e9b8b572b46e50F70726",
  ZYTDeflation: "0xED866239D6Fcd7164C54b3431f745850fACc60c1",
};

async function main() {
  for (const [name, addr] of Object.entries(ADDRS)) {
    const onchain = await ethers.provider.getCode(addr);
    const artifact = JSON.parse(
      fs.readFileSync(
        `artifacts/contracts/${name}.sol/${name}.json`,
        "utf8"
      )
    );
    const local = artifact.deployedBytecode;
    const match = onchain === local;
    console.log(`[${name}] 线上 code 长度: ${(onchain.length - 2) / 2} bytes | 本地 deployedBytecode 长度: ${(local.length - 2) / 2} bytes`);
    console.log(`[${name}] 字节码完全一致: ${match}`);
    if (!match) {
      // 找第一个差异位置
      let i = 0;
      while (i < onchain.length && i < local.length && onchain[i] === local[i]) i++;
      console.log(`[${name}] 首个差异偏移: ${i} (0x${i.toString(16)})`);
      console.log(`[${name}] 线上片段: ${onchain.slice(Math.max(0, i - 20), i + 40)}`);
      console.log(`[${name}] 本地片段: ${local.slice(Math.max(0, i - 20), i + 40)}`);
    }
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message.slice(0, 400));
  process.exit(1);
});
