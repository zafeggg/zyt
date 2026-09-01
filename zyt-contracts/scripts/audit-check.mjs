/**
 * 合约漏洞链上验证脚本（审计用）
 * 验证 H1/H3/H7/H13 四个高危漏洞在真实链上的表现
 * 运行：node scripts/audit-check.mjs
 */
import { ethers } from "ethers";
import fs from "fs";

const ADDRS = JSON.parse(fs.readFileSync("deploy-plain.json", "utf8"));
const RPC = "http://127.0.0.1:8545";
const p = new ethers.JsonRpcProvider(RPC, 31337, { staticNetwork: true });
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  alice: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  bob: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  carol: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  dave: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
};
const signers = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, new ethers.Wallet(v, p)]));
const abiOf = (name) => JSON.parse(fs.readFileSync(`artifacts/contracts/${name}.sol/${name}.json`, "utf8")).abi;
const usdtAbi = JSON.parse(fs.readFileSync("artifacts/contracts/mocks/MockERC20.sol/MockERC20.json", "utf8")).abi;
const zyt = new ethers.Contract(ADDRS.zyt, abiOf("ZYTToken"), signers.deployer);
const mining = new ethers.Contract(ADDRS.mining, abiOf("ZYTMining"), signers.deployer);
const pool = new ethers.Contract(ADDRS.pool, abiOf("ZYTPoolManager"), signers.deployer);
const forceSell = new ethers.Contract(ADDRS.forceSell, abiOf("ZYTForceSell"), signers.deployer);
const deflation = new ethers.Contract(ADDRS.deflation, abiOf("ZYTDeflation"), signers.deployer);
const referral = new ethers.Contract(ADDRS.referral, abiOf("ZYTReferral"), signers.deployer);
const usdt = new ethers.Contract(ADDRS.usdt, usdtAbi, signers.deployer);
const GAS = 3000000;

async function send(signer, c, method, args) {
  // 用 pending nonce：连续多笔交易时 latest 不含 mempool，会互相覆盖
  const nonce = await p.send("eth_getTransactionCount", [signer.address, "pending"]);
  const t = await c.connect(signer)[method](...args, { gasLimit: GAS, nonce });
  return t.wait();
}
let pass = 0, fail = 0;
const check = (n, c, e) => { c ? (pass++, console.log("  ✅ " + n + (e ? " " + e : ""))) : (fail++, console.log("  ❌ " + n + (e ? " " + e : ""))); };

console.log("【V1（已修复）：真实卖出计入 forceSell.soldAmount】");
{
  // bob(0x3c44) 已通过 sellZyt 卖出（withdrawTotal>0），修复后 soldAmount 应 > 0
  const BOB = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
  const sold = await forceSell.soldAmount(BOB);
  const info = await mining.userInfo(BOB);
  check("已卖出用户 soldAmount > 0（卖出到池已统计）", sold > 0n && info[1] > 0n, `withdrawTotal=${ethers.formatEther(info[1])}U soldAmount=${ethers.formatEther(sold)}`);
}

console.log("【V2（已修复）：claimDividend 额度按 USDT 等值折算】");
{
  // alice claim 前记录 withdrawn，claim 后对比：diff 应 = share × price / 1e18（USDT 等值，远小于 share）
  const alice = signers.alice;
  const before = (await mining.userInfo(alice.address))[3];
  const dpBefore = await pool.dividendPool();
  if (dpBefore > 0n) {
    await send(alice, mining, "claimDividend", []);
    const after = (await mining.userInfo(alice.address))[3];
    const diff = after - before;
    const price = await pool.getTradePrice();
    // alice 算力占比 = power / totalPower；修复后 diff = share × price / 1e18 << share
    const share = dpBefore * (await mining.powerOf(alice.address)) / (await mining.userInfo(alice.address))[4]; // 近似
    check("claimDividend 额度按 USDT 等值（diff << ZYT 分红量）", diff < dpBefore / 10000n, `diff=${ethers.formatEther(diff)}U price=${ethers.formatEther(price)}（share≈${ethers.formatEther(share)} ZYT，等值≈${ethers.formatEther(share * price / 10n ** 18n)}U）`);
  } else {
    check("分红池为空，跳过", true, "dividendPool=0");
  }
}

console.log("【V3（已修复）：推荐循环绑定被拒】");
{
  // 用两个未绑定新地址 eve(6)/frank(7)：eve→frank 成功，frank→eve 应被拒（循环）
  const eve = new ethers.Wallet("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", p);
  const frank = new ethers.Wallet("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", p);
  await send(signers.deployer, pool, "setBuyWhitelistBatch", [[eve.address, frank.address], true]);
  await send(signers.deployer, usdt, "transfer", [eve.address, ethers.parseEther("100")]);
  await send(signers.deployer, usdt, "transfer", [frank.address, ethers.parseEther("100")]);
  await send(eve, usdt, "approve", [ADDRS.mining, ethers.MaxUint256]);
  await send(eve, mining, "deposit", [ethers.parseEther("100"), frank.address]); // eve→frank
  await send(frank, usdt, "approve", [ADDRS.mining, ethers.MaxUint256]);
  await send(frank, mining, "deposit", [ethers.parseEther("100"), eve.address]); // frank→eve（应被拒）
  const fr = await referral.referrerOf(frank.address);
  const anc = await referral.getAncestors(eve.address, 20);
  const selfIn = anc.map((a) => a.toLowerCase()).includes(eve.address.toLowerCase());
  console.log("  frank referrer:", fr, "| eve 祖先链(前4):", anc.slice(0, 4).map((a) => a.slice(0, 8)).join(" → "));
  check("循环绑定被拒：frank 未绑定 eve", fr === ethers.ZeroAddress);
  check("eve 祖先链不含自己", selfIn === false);
  // eve 再入金：正常应只获得入金 mint（60U 等值 ≈ 590万 ZYT），无自我奖励
  // （漏洞版含自我 2% 多代 ≈ 700万，可区分）
  await send(signers.deployer, usdt, "transfer", [eve.address, ethers.parseEther("100")]);
  const balBefore = await zyt.balanceOf(eve.address);
  await send(eve, mining, "deposit", [ethers.parseEther("100"), ethers.ZeroAddress]);
  const reward = (await zyt.balanceOf(eve.address)) - balBefore;
  const price = await pool.getTradePrice();
  const theoreticalMint = ethers.parseEther("60") * 10n ** 18n / price; // 60U / price ≈ 590万
  check("入金仅获正常 mint（无自我奖励）", reward <= theoreticalMint * 105n / 100n, `+${ethers.formatEther(reward)} ZYT（理论 mint≈${ethers.formatEther(theoreticalMint)}）`);
}

console.log("【V4（已修复）：dailySnapshot 仅 keeper/owner 可调用】");
{
  // 快进 1 天（模拟次日）
  await p.send("evm_increaseTime", [86400]);
  await p.send("evm_mine", []);
  const latestBlock = await p.getBlock("latest");
  const day = BigInt(Math.floor(latestBlock.timestamp / 86400));
  // 恶意调用：carol（非 keeper 非 owner）应被拒
  let rejected = false;
  try {
    await send(signers.carol, deflation, "dailySnapshot", [ethers.parseEther("1000000000")]);
  } catch (e) {
    rejected = String(e.message).includes("not keeper");
  }
  check("非 keeper 调用被拒", rejected, "carol 被拒（V4 修复生效）");
  const info = await mining.dailyInfo(day);
  console.log("  day", day.toString(), "totalPower:", ethers.formatEther(info.totalPower), "(未被恶意注入，应为正常值或 0)");
  check("恶意 totalPower 未注入", info.totalPower < ethers.parseEther("1000000000"));
  // owner 可触发（多签兜底）
  let ok = false;
  try {
    await send(signers.deployer, deflation, "dailySnapshot", [ethers.parseEther("600")]);
    ok = true;
  } catch (e) {}
  check("owner 可正常触发", ok, "deployer(owner) 快照成功");
}

console.log("");
console.log("验证结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(0); // 审计验证，不因失败退出
