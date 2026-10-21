// 热切换 fork 演练：接线 → 账本回填比对 → 回退恢复
//
// 运行方式（不设 FORK_RPC 时整组跳过，不影响常规测试）：
//   FORK_RPC=https://bsc-rpc.publicnode.com npx hardhat test test/hotswap-fork.test.js
//
// 三阶段断言：
//   ① 基线：旧代币四点指向旧合约、池储备、分红池、launchDay
//   ② 接线：新 5 合约部署并接线后，代币四点指向新合约，且池储备与①完全一致（证明零资产移动）
//   ③ 回填+回退：setUserData 回填 1 个真实用户并逐字段比对；四点回退后读数复原
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const OLD = {
  config: "0x4FEFe79A90Bf7C9BD2699030Ee1ad0360f4B1B22",
  token: "0xa64E6ab9A8a61f55eE9B1521312783AE033fd546",
  pool: "0x57d8Ec0D9Ef0822dFc5D08Db686D182351580028",
  mining: "0x0119cf2eac935447f2Dd60C457190fAEa116fd22",
  forceSell: "0xaE0EeD16e6f7ca4736294a6c2E4a5b87d02672C8",
  deflation: "0xF44fE232d26F4E845Be75960bc0a65aB12898D73",
  referral: "0x43018AF273296064991c018955c636fB45eB0dad",
  creator: "0x41799040658764d91C94AF16b8B461f2fc1A040F",
  compute: "0xf6Cc1617C480D1a412549c8a11618FF30c31f048",
  pair: "0x9EC33C56eCE848e6fF64a823f6262068C2b9cD69",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
};

const TOKEN_ABI = [
  "function owner() view returns (address)",
  "function pool() view returns (address)",
  "function forceSell() view returns (address)",
  "function ledger() view returns (address)",
  "function configAddr() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function getUserCount() view returns (uint256)",
  "function getUserAt(uint256) view returns (address)",
  "function setPool(address)",
  "function setForceSell(address)",
  "function setLedger(address)",
  "function setConfig(address)",
];
const MINING_READ = [
  "function users(address) view returns (uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256,uint256,uint256,uint256,uint256,bool)",
  "function dividendClaimedDay(address) view returns (uint256)",
  "function directDownlineDeposit(address) view returns (uint256)",
  "function launchDay() view returns (uint64)",
];
const MINING_WRITE = [
  "function setUserData(address[] users, (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)[] data)",
  "function setLaunchDay(uint256)",
];
const PAIR_ABI = ["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"];
const POOL_ABI = ["function dividendPoolZyt() view returns (uint256)", "function pair() view returns (address)"];

const run = process.env.FORK_RPC ? describe : describe.skip;

run("热切换 fork 演练（需 FORK_RPC）", function () {
  this.timeout(600_000);

  let owner, deployer, token, oldMining, oldPool, pair, baseline;

  before(async () => {
    const [d0] = await ethers.getSigners();
    deployer = d0;
    token = new ethers.Contract(OLD.token, TOKEN_ABI, ethers.provider);
    oldMining = new ethers.Contract(OLD.mining, [...MINING_READ, ...MINING_WRITE], ethers.provider);
    oldPool = new ethers.Contract(OLD.pool, POOL_ABI, ethers.provider);
    pair = new ethers.Contract(OLD.pair, PAIR_ABI, ethers.provider);

    // 旧代币 owner 为治理多签，fork 上通过 impersonate 行使权限
    owner = await token.owner();
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [owner] });
    await network.provider.request({ method: "hardhat_setBalance", params: [owner, "0x56BC75E2D63100000"] });
  });

  it("① 基线：旧代币四点指向旧合约，池储备/分红池/launchDay 落档", async () => {
    expect((await token.pool()).toLowerCase()).to.equal(OLD.pool.toLowerCase());
    expect((await token.forceSell()).toLowerCase()).to.equal(OLD.forceSell.toLowerCase());
    expect((await token.ledger()).toLowerCase()).to.equal(OLD.mining.toLowerCase());
    expect((await token.configAddr()).toLowerCase()).to.equal(OLD.config.toLowerCase());

    const r = await pair.getReserves();
    const zytIs0 = (await pair.token0()).toLowerCase() === OLD.token.toLowerCase();
    baseline = {
      zyt: zytIs0 ? r[0] : r[1],
      usdt: zytIs0 ? r[1] : r[0],
      supply: await token.totalSupply(),
      dividendPool: await oldPool.dividendPoolZyt(),
      launchDay: await oldMining.launchDay(),
    };
    expect(baseline.zyt).to.be.gt(0n);
    expect(baseline.usdt).to.be.gt(0n);
  });

  it("② 接线：部署 5 合约并接线，代币四点切换后池储备与基线完全一致", async () => {
    const [signer] = await ethers.getSigners();
    const cfg = await (await ethers.getContractFactory("ZYTConfig")).deploy();
    const pool = await (await ethers.getContractFactory("ZYTPoolManager")).deploy(await cfg.getAddress(), OLD.token, OLD.usdt);
    const mining = await (
      await ethers.getContractFactory("ZYTMining", { libraries: { ZYTCompute: OLD.compute } })
    ).deploy(await cfg.getAddress(), await pool.getAddress(), OLD.referral, OLD.token, OLD.usdt);
    const forceSell = await (await ethers.getContractFactory("ZYTForceSell")).deploy(OLD.token);
    const deflation = await (
      await ethers.getContractFactory("ZYTDeflation")
    ).deploy(await cfg.getAddress(), await pool.getAddress(), await mining.getAddress());

    // 新池管内部接线（先内后外，避免 hook 读到未初始化状态）
    await pool.setPair(OLD.pair);
    await pool.setLocker(OLD.creator);
    await pool.setMining(await mining.getAddress());
    await pool.setDeflation(await deflation.getAddress());

    await forceSell.setKeeper(signer.address);
    await forceSell.setMining(await mining.getAddress());
    await forceSell.setConfig(await cfg.getAddress());

    await mining.setLaunchDay(baseline.launchDay);

    // 新 Config 记录地址（供跨合约读取）
    await cfg.setAddress("zyt", OLD.token);
    await cfg.setAddress("usdt", OLD.usdt);
    await cfg.setAddress("pool", await pool.getAddress());
    await cfg.setAddress("mining", await mining.getAddress());
    await cfg.setAddress("forceSell", await forceSell.getAddress());
    await cfg.setAddress("deflation", await deflation.getAddress());
    await cfg.setAddress("referral", OLD.referral);
    await cfg.setAddress("creator", OLD.creator);
    await cfg.setAddress("pair", OLD.pair);

    // 旧 Referral / 旧 Creator 授权新逻辑合约
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [owner] });
    const ownerSigner = await ethers.getSigner(owner);
    await new ethers.Contract(OLD.referral, ["function setMining(address)"], ownerSigner).setMining(await mining.getAddress());
    await new ethers.Contract(OLD.creator, ["function setPoolManager(address)"], ownerSigner).setPoolManager(await pool.getAddress());

    // 代币四点切换（原子顺序：池 → 档位 → 账本 → Config）
    await token.connect(ownerSigner).setPool(await pool.getAddress());
    await token.connect(ownerSigner).setForceSell(await forceSell.getAddress());
    await token.connect(ownerSigner).setLedger(await mining.getAddress());
    await token.connect(ownerSigner).setConfig(await cfg.getAddress());

    expect((await token.pool()).toLowerCase()).to.equal((await pool.getAddress()).toLowerCase());
    expect((await token.forceSell()).toLowerCase()).to.equal((await forceSell.getAddress()).toLowerCase());
    expect((await token.ledger()).toLowerCase()).to.equal((await mining.getAddress()).toLowerCase());
    expect((await token.configAddr()).toLowerCase()).to.equal((await cfg.getAddress()).toLowerCase());

    // 核心证据：零资产移动
    const r = await pair.getReserves();
    const zytIs0 = (await pair.token0()).toLowerCase() === OLD.token.toLowerCase();
    expect(zytIs0 ? r[0] : r[1]).to.equal(baseline.zyt);
    expect(zytIs0 ? r[1] : r[0]).to.equal(baseline.usdt);
    expect(await token.totalSupply()).to.equal(baseline.supply);

    // 新池管初始滑点 = 基础档（未定档）
    expect(await pool.getCurrentSlippage()).to.equal(500n);
    expect(await mining.launchDay()).to.equal(baseline.launchDay);
  });

  it("③ 回填 1 个真实用户并回退：字段一致、读数复原", async () => {
    const n = await token.getUserCount();
    expect(n).to.be.gt(0n);
    const user = await token.getUserAt(0);
    const u = await oldMining.users(user);
    const cursor = await oldMining.dividendClaimedDay(user);
    const direct = await oldMining.directDownlineDeposit(user);

    const cfgAddr = await token.configAddr();
    const poolAddr = await new ethers.Contract(cfgAddr, ["function pool() view returns (address)"], ethers.provider).pool();
    const miningAddr = await new ethers.Contract(cfgAddr, ["function mining() view returns (address)"], ethers.provider).mining();
    const newMining = new ethers.Contract(miningAddr, [...MINING_READ, ...MINING_WRITE], ethers.provider);

    // 元组顺序与合约结构体一致：12 uint + dividendClaimedDay + directDeposit + 2 bool
    const tuple = [u[0], u[1], u[2], u[3], u[4], u[6], u[7], u[8], u[9], u[10], u[11], cursor, direct, u[5], u[12]];
    await newMining.setUserData([user], [tuple]);

    const after = await newMining.users(user);
    for (const i of [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11]) expect(after[i]).to.equal(u[i]);
    expect(after[5]).to.equal(u[5]);
    expect(after[12]).to.equal(u[12]);
    expect(await newMining.dividendClaimedDay(user)).to.equal(cursor);
    expect(await newMining.directDownlineDeposit(user)).to.equal(direct);

    // 回退：四点改回旧地址（Referral / Creator 一并回退）
    const ownerSigner = await ethers.getSigner(owner);
    await token.connect(ownerSigner).setPool(OLD.pool);
    await token.connect(ownerSigner).setForceSell(OLD.forceSell);
    await token.connect(ownerSigner).setLedger(OLD.mining);
    await token.connect(ownerSigner).setConfig(OLD.config);
    await new ethers.Contract(OLD.referral, ["function setMining(address)"], ownerSigner).setMining(OLD.mining);
    await new ethers.Contract(OLD.creator, ["function setPoolManager(address)"], ownerSigner).setPoolManager(OLD.pool);

    expect((await token.pool()).toLowerCase()).to.equal(OLD.pool.toLowerCase());
    expect((await token.forceSell()).toLowerCase()).to.equal(OLD.forceSell.toLowerCase());
    expect((await token.ledger()).toLowerCase()).to.equal(OLD.mining.toLowerCase());
    expect((await token.configAddr()).toLowerCase()).to.equal(OLD.config.toLowerCase());

    // 回退后旧账本读数与基线一致（只读校验，未写入旧合约）
    const uAfter = await oldMining.users(user);
    for (let i = 0; i < 13; i++) expect(uAfter[i]).to.equal(u[i]);

    const r = await pair.getReserves();
    const zytIs0 = (await pair.token0()).toLowerCase() === OLD.token.toLowerCase();
    expect(zytIs0 ? r[0] : r[1]).to.equal(baseline.zyt);
    expect(await new ethers.Contract(OLD.pool, POOL_ABI, ethers.provider).dividendPoolZyt()).to.equal(baseline.dividendPool);
    expect(await oldMining.launchDay()).to.equal(baseline.launchDay);
  });
});
