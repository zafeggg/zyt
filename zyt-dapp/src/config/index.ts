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
  rpc: "https://bsc-dataseed.binance.org",
  apiBase: envApiBase || "/api", // v13：主网上线同源反代；纯直连可留空用 VITE_API_BASE="" 覆盖
  contracts: {
    config: "",
    gst: "",
    zyt: "",
    forceSell: "",
    pool: "",
    referral: "",
    mining: "",
    deflation: "",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
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
