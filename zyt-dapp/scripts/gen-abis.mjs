// 从 zyt-contracts 的 hardhat artifacts 提取 ABI，生成 src/abis/*.ts
// 用法：cd zyt-dapp && node scripts/gen-abis.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(__dirname, "..", "..", "zyt-contracts", "artifacts", "contracts");
const OUT_DIR = join(__dirname, "..", "src", "abis");

const MAP = [
  { src: "ZYTConfig.sol/ZYTConfig.json", out: "config.ts", name: "CONFIG_ABI" },
  { src: "ZYTForceSell.sol/ZYTForceSell.json", out: "forcesell.ts", name: "FORCESELL_ABI" },
  { src: "ZYTToken.sol/ZYTToken.json", out: "zyt.ts", name: "ZYT_ABI" },
  { src: "ZYTPoolManager.sol/ZYTPoolManager.json", out: "pool.ts", name: "POOL_ABI" },
  { src: "ZYTMining.sol/ZYTMining.json", out: "mining.ts", name: "MINING_ABI" },
  { src: "ZYTLiquidityCreator.sol/ZYTLiquidityCreator.json", out: "creator.ts", name: "CREATOR_ABI" },
  { src: "mocks/MockERC20.sol/MockERC20.json", out: "usdt.ts", name: "USDT_ABI" },
];

mkdirSync(OUT_DIR, { recursive: true });

let ok = 0;
for (const item of MAP) {
  const artifactPath = join(ARTIFACTS, item.src);
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch (err) {
    console.warn(`跳过 ${item.src}：${err.message}`);
    continue;
  }
  const solName = item.src.split("/")[0];
  const header = `// 自动生成：contracts/${solName}\n// 由 scripts/gen-abis.mjs 生成，请勿手工编辑\n`;
  const body = `${header}export const ${item.name} = ${JSON.stringify(artifact.abi, null, 1)};\n`;
  writeFileSync(join(OUT_DIR, item.out), body, "utf8");
  console.log(`写入 src/abis/${item.out}  （${artifact.abi.length} 条目）`);
  ok++;
}
console.log(`完成：${ok} 个 ABI 文件已更新`);
