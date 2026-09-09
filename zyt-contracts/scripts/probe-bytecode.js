/* global ethers */
/**
 * @title 探针：对比线上合约字节码 vs 本地 artifacts 部署字节码，判定版本一致性
 * @usage  npx hardhat run scripts/probe-bytecode.js --network bscTestnet
 */
const { ethers } = require("hardhat");
require("dotenv").config();
const fs = require("fs");

const ADDRS = {
  ZYTMining: "0x1ffCec692Ef2c8287C1dE7248B0621bdAd135703",
  ZYTPoolManager: "0x020927BC660f7631709d388C992979359196DcfD",
  ZYTDeflation: "0x16E8A145D015D80892e5CFe8cE305F0717F229a9",
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
