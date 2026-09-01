// 纯 ethers 模拟交易（本地联调）：入金/快照/领取/卖出
// 用法：node scripts/simulate-plain.js
const { ethers } = require("ethers");
const fs = require("fs");

const RPC = "http://127.0.0.1:8545";
const ADDRS = JSON.parse(fs.readFileSync("deploy-plain.json", "utf8"));
const GAS = 5_000_000;
// hardhat 测试账户：deployer(owner) alice(1) bob(2) carol(3)
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // deployer / ZYTConfig owner
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];

function artifact(rel) {
  const base = rel.split("/").pop();
  const j = JSON.parse(fs.readFileSync(`artifacts/contracts/${rel}.sol/${base}.json`, "utf8"));
  return j.abi;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, 31337);
  const users = KEYS.map((k) => new ethers.Wallet(k, provider));
  const [deployer, alice, bob, carol] = users;

  const usdt = new ethers.Contract(ADDRS.usdt, artifact("mocks/MockERC20"), provider);
  const mining = new ethers.Contract(ADDRS.mining, artifact("ZYTMining"), provider);
  const zyt = new ethers.Contract(ADDRS.zyt, artifact("ZYTToken"), provider);
  const deflation = new ethers.Contract(ADDRS.deflation, artifact("ZYTDeflation"), provider);
  const pool = new ethers.Contract(ADDRS.pool, artifact("ZYTPoolManager"), provider);

  async function send(contract, method, args, signer) {
    const c = contract.connect(signer);
    // 原生 RPC 查询最新 nonce（绕开 ethers nonce 缓存）
    const nonce = await provider.send("eth_getTransactionCount", [signer.address, "latest"]);
    const t = await c[method](...args, { gasLimit: GAS, nonce });
    await t.wait();
    return t;
  }

  // 充值 USDT + 授权
  for (const u of users) {
    await send(usdt, "faucet", [ethers.parseEther("500")], u);
    await send(usdt, "approve", [ADDRS.mining, ethers.MaxUint256], u);
  }
  console.log("USDT funded");

  // v7：模拟用户加入买入白名单（白名单默认开启，否则入金被拒）
  await send(pool, "setBuyWhitelistBatch", [[alice.address, bob.address, carol.address], true], deployer);
  console.log("whitelist set");

  // 三笔入金（含推荐）
  await send(mining, "deposit", [ethers.parseEther("300"), ethers.ZeroAddress], alice);
  await send(mining, "deposit", [ethers.parseEther("200"), alice.address], bob);
  await send(mining, "deposit", [ethers.parseEther("100"), alice.address], carol);
  console.log("deposits done");

  // 每日快照（全网算力 600）
  await send(deflation, "dailySnapshot", [ethers.parseEther("600")], alice);
  console.log("snapshot done");

  // alice 领取当日产出
  const day = BigInt(Math.floor(Date.now() / 1000 / 86400));
  await send(mining, "claimReward", [day], alice);
  console.log("alice claim done");

  // bob 卖出 30% ZYT
  const bobZyt = await zyt.balanceOf(bob.address);
  await send(zyt, "approve", [ADDRS.pool, ethers.MaxUint256], bob);
  const sellAmt = (bobZyt * 30n) / 100n;
  await send(mining, "sellZyt", [sellAmt], bob);
  console.log("bob sold", ethers.formatEther(sellAmt), "ZYT");

  // 输出池状态
  const [gst, zytPool, usdtPool, price, stage, slip] = await Promise.all([
    pool.poolGST(), pool.poolZYT(), pool.poolUSDT(), pool.getPrice(), pool.getStage(), pool.getCurrentSlippage(),
  ]);
  console.log("pool: gst=%s zyt=%s usdt=%s price=%s stage=%s slip=%s%%",
    ethers.formatEther(gst), ethers.formatEther(zytPool), ethers.formatEther(usdtPool),
    ethers.formatEther(price), stage, Number(slip) / 100);
}

main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
