import { ethers } from 'ethers';
import fs from 'fs';
const ADDRS = JSON.parse(fs.readFileSync('deploy-plain.json', 'utf8'));
const RPC = 'http://127.0.0.1:8545';
const p = new ethers.JsonRpcProvider(RPC, 31337);
const keys = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  alice: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  bob: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  carol: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  dave: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
};
const signers = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, new ethers.Wallet(v, p)]));
const abiOf = (rel) => {
  const parts = rel.split('/');
  const base = parts.pop();
  return JSON.parse(fs.readFileSync('artifacts/contracts/' + rel + '.sol/' + base + '.json', 'utf8')).abi;
};
const pool = new ethers.Contract(ADDRS.pool, abiOf('ZYTPoolManager'), signers.deployer);
const mining = new ethers.Contract(ADDRS.mining, abiOf('ZYTMining'), signers.deployer);
const zyt = new ethers.Contract(ADDRS.zyt, abiOf('ZYTToken'), signers.deployer);
const usdt = new ethers.Contract(ADDRS.usdt, abiOf('mocks/MockERC20'), signers.deployer);
const GAS = 3000000;
async function send(signer, c, method, args) {
  const nonce = await p.send('eth_getTransactionCount', [signer.address, 'latest']);
  const t = await c.connect(signer)[method](...args, { gasLimit: GAS, nonce });
  return t.wait();
}
let pass = 0, fail = 0;
const check = (name, cond, extra) => { cond ? (pass++, console.log('  [PASS] ' + name + ' ' + (extra||''))) : (fail++, console.log('  [FAIL] ' + name + ' ' + (extra||''))); };

console.log('【检测1：买入白名单】');
const dave = signers.dave;
// 幂等：确保 dave 从"非白名单"状态开始（重复运行也能通过）
await send(signers.deployer, pool, 'setBuyWhitelist', [dave.address, false]);
await send(dave, usdt, 'faucet', [ethers.parseEther('100')]);
await send(dave, usdt, 'approve', [ADDRS.mining, ethers.MaxUint256]);
let rejected = false;
try { await send(dave, mining, 'deposit', [ethers.parseEther('100'), ethers.ZeroAddress]); } catch (e) { rejected = String(e.message).includes('not whitelisted'); }
check('非白名单 dave 入金被拒', rejected);
await send(signers.deployer, pool, 'setBuyWhitelist', [dave.address, true]);
await send(dave, mining, 'deposit', [ethers.parseEther('100'), ethers.ZeroAddress]);
check('加白后 dave 入金成功', (await mining.userInfo(dave.address))[0] > 0n);

console.log('【检测2：当日快照基准价】');
const tpBefore = await pool.getTradePrice();
const realBefore = await pool.getPrice();
check('入金后实时价 > 锁定价(当日恒定)', realBefore > tpBefore, 'real=' + ethers.formatEther(realBefore) + ' trade=' + ethers.formatEther(tpBefore));
const daveZyt = await zyt.balanceOf(dave.address);
await send(dave, zyt, 'approve', [ADDRS.pool, ethers.MaxUint256]);
const balBefore = await usdt.balanceOf(dave.address);
await send(dave, mining, 'sellZyt', [daveZyt / 10n]);
const usdtOut = (await usdt.balanceOf(dave.address)) - balBefore;
check('卖出按锁定价成交（usdtOut > 0）', usdtOut > 0n, 'usdtOut=' + ethers.formatEther(usdtOut) + 'U trade=' + ethers.formatEther(tpBefore));

console.log('【检测3：链上卖出统计（增量断言，幂等）】');
// 记录 dave 检测前状态（链上可能已有历史，用增量验证本次操作）
const s0 = await zyt.getSellInfo(dave.address);
const sellCount0 = Number(s0[0]);
const usdt0 = BigInt(s0[2]);
const daveZytNow = await zyt.balanceOf(dave.address);
await send(dave, zyt, 'approve', [ADDRS.pool, ethers.MaxUint256]);
// 第一次卖出
const balU0 = await usdt.balanceOf(dave.address);
await send(dave, mining, 'sellZyt', [daveZytNow / 10n]);
const s1 = await zyt.getSellInfo(dave.address);
check('卖出 1 次后 sellCount +1', Number(s1[0]) === sellCount0 + 1, sellCount0 + '->' + s1[0]);
check('totalSellZyt 增加 = 卖出量', BigInt(s1[1]) - BigInt(s0[1]) === daveZytNow / 10n);
const usdtGain1 = (await usdt.balanceOf(dave.address)) - balU0;
check('totalSellUsdt 增加 = 本次成交额', BigInt(s1[2]) - usdt0 === usdtGain1, 'usdt+' + ethers.formatEther(usdtGain1));
check('firstReceiveAt 已记录', BigInt(s1[3]) > 0n);
// userList 去重（dave 至多出现一次）
const countAll = Number(await zyt.getUserCount());
const daveOccur = [];
for (let i = 0; i < countAll; i++) {
  const a = (await zyt.getUserAt(i)).toLowerCase();
  if (a === dave.address.toLowerCase()) daveOccur.push(i);
}
check('userList 中 dave 恰好一次（去重）', daveOccur.length === 1, 'count=' + countAll + ' occur=' + daveOccur.length);
// 第二次卖出
await send(dave, mining, 'sellZyt', [daveZytNow / 10n]);
const s2 = await zyt.getSellInfo(dave.address);
check('二次卖出 sellCount 再 +1', Number(s2[0]) === Number(s1[0]) + 1, s1[0] + '->' + s2[0]);
// 复查去重
const countAll2 = Number(await zyt.getUserCount());
let daveOccur2 = 0;
for (let i = 0; i < countAll2; i++) {
  if ((await zyt.getUserAt(i)).toLowerCase() === dave.address.toLowerCase()) daveOccur2++;
}
check('二次卖出后 userList 仍不重复', daveOccur2 === 1, 'count=' + countAll2);

console.log('');
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
