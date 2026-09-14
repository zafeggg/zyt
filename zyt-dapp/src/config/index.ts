// ===== 链与合约地址配置 =====
// 本地默认使用 hardhat 部署地址；BSC mainnet 部署后替换
// v13：API 基址统一走 import.meta.env.VITE_API_BASE（构建时注入），未注入时按环境回退：
//       local 分支 -> http://localhost:8080（本地联调直连 keeper）
//       bscTestnet / bsc 分支 -> /api（同源相对路径，生产由 Nginx 反代到 keeper 8080，方案 B）
// 注意：页面在浏览器打开时 localhost 指向用户本机，联调只在本机有效；发布请用 VITE_API_BASE 或 /api

export interface ChainConfig {
  name: string;
  chainId: number;
  rpc: string;
  // 链下服务 API（keeper）基础地址：留空 = 纯合约直连（降级模式）
  apiBase: string;
  // v15：根邀请码（营销地址）——注册页在无 ?ref= 参数时预填；留空则注册页不预填、仅手输
  rootInvite: string;
  contracts: {
    config: string;
    gst: string;
    zyt: string;
    forceSell: string;
    pool: string;
    referral: string;
    mining: string;
    deflation: string;
    usdt: string;
  };
}

// 构建时注入：VITE_API_BASE=http://1.2.3.4:8080 或留空走各分支默认
const envApiBase = (import.meta.env.VITE_API_BASE as string | undefined) || "";

const LOCAL: ChainConfig = {
  name: "hardhat",
  chainId: 31337,
  rpc: "http://127.0.0.1:8545",
  apiBase: envApiBase || "http://localhost:8080",
  // 本地测试：hardhat 账户 #0 充当根邀请码
  rootInvite: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  contracts: {
    // 来自 scripts/deploy.js 本地部署输出
    config: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    gst: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    zyt: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
    forceSell: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
    pool: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
    referral: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
    mining: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
    deflation: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
    usdt: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  },
};

const BSC_TESTNET: ChainConfig = {
  name: "BSC Testnet",
  chainId: 97,
  rpc: "https://bsc-testnet-rpc.publicnode.com",
  // v13：testnet 生产同源反代 /api（Nginx 代理 keeper）；联调可 VITE_API_BASE=http://localhost:8080 覆盖
  apiBase: envApiBase || "/api",
  // 测试网：临时用集成测试钱包占位，正式营销地址确定后替换
  rootInvite: "0x87C0aF08c0F974E86CAC508faA239bB1Cc2f2241",
  contracts: {
    // 第五套部署地址（2026-09-01，与 smoke-testnet.js / keeper .env 一致）
    config: "0x55F4e5F732ACfa49015AB6546a2766Db7534cDbd",
    gst: "0xD63C5528008A6c9C521Fe2BEA9349bE4687b5ed3",
    zyt: "0xdF18105bB57165c59AD651Eda1B4d896412d4166",
    forceSell: "0x24685AF81fc8443ED46b11Cb17Ba7af0ae55ce06",
    pool: "0x020927BC660f7631709d388C992979359196DcfD",
    referral: "0x3C999B3E1292d33B1aB22071691674A38Da84e0E",
    mining: "0x1ffCec692Ef2c8287C1dE7248B0621bdAd135703",
    deflation: "0x16E8A145D015D80892e5CFe8cE305F0717F229a9",
    // 第五套用 MockUSDT（非官方 USDT；测试钱包余额/授权均针对此地址）
    usdt: "0x7749da5d64c0ABA2A8203c0C630d31e7D13cFb29",
  },
};

const BSC_MAINNET: ChainConfig = {
  name: "BSC",
  chainId: 56,
  // v15：旧域名 bsc-dataseed.binance.org 国内直连 ECONNRESET，换 publicnode（实测可用）
  rpc: "https://bsc-rpc.publicnode.com",
  apiBase: envApiBase || "/api", // v13：主网上线同源反代；纯直连可留空用 VITE_API_BASE="" 覆盖
  // 官方根邀请码 = 营销 Safe 地址（2026-09-14 已链上核验：threshold 2 / owners 3）
  // 说明：根邀请码当前不参与注册页预填（决策 22），仅作官方码取值与后续运营策略用
  rootInvite: "0x1bc03Fe18F9BabBc32f0B4046E13e387E9D16786",
  contracts: {
    // ⚠️ 主网 TestUSDT 试运行版（2026-09-14 部署并 verify，deployments/mainnet-test-20260914.json）
    // 正式版（真实 USDT）重部署后需整段替换（见上线操作手册附录 E）
    config: "0x7247791Bd79e831C78B8DCFDF820C43a7386f370",
    gst: "0x3D4A87Bb1487737b97BD4c86a56EDCA9f794F784",
    zyt: "0xAB4c090CD436D1d93Aa6D18067A3217206Bd097A",
    forceSell: "0xD944f0A514b92F9adBc805F7E94E75aD489Af2A6",
    pool: "0xe2b0DdB48f4455830D38cD765d9b79DBd906c291",
    referral: "0x74285fC2c76F1C5Ec1912bA6EB2788B353C26970",
    mining: "0xFC97Bf17243C2ef9A8442c190A1897B61745C830",
    deflation: "0x95e60944e0DF1846f5498B4b8A678564f9aCDe26",
    // 试运行版为 TestUSDT（MockERC20，bscscan 已 verify）；正式版替换为真实 USDT 0x55d398326f99059fF775485246999027B3197955
    usdt: "0x4cd6d10260Cdfc55A9dcf97dfffade73080E7608",
  },
};

export const CHAINS: Record<string, ChainConfig> = {
  local: LOCAL,
  bscTestnet: BSC_TESTNET,
  bsc: BSC_MAINNET,
};

export function currentChain(): ChainConfig {
  const name = import.meta.env.VITE_CHAIN || "local";
  return CHAINS[name] || LOCAL;
}

export const ETHERSCAN_BASE = "https://bscscan.com";
