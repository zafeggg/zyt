// ===== 链与合约地址配置 =====
// 本地默认使用 hardhat 部署地址；BSC mainnet 部署后替换

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

const LOCAL: ChainConfig = {
  name: "hardhat",
  chainId: 31337,
  rpc: "http://127.0.0.1:8545",
  apiBase: "http://localhost:8080",
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
  // v11：testnet 联调接入本地 keeper（API 优先；keeper 断 → 合约直连降级）
  apiBase: "http://localhost:8080",
  contracts: {
    // 第五套部署地址（2026-09-01，与 smoke-testnet.js / keeper .env 一致）
    config: "0x62a96b2880fD282BC0984db800057F1CDFe2873C",
    gst: "0x6E612B64885EBcd2511f97d8eC74c80fAE08FF20",
    zyt: "0x9bd8CD99e61BE9c1FbB35282345111017a80F107",
    forceSell: "0x519F2179C5Fbe481034BE663C07e04b692fA6D78",
    pool: "0x701A4A0cF59a05ada702e9b8b572b46e50F70726",
    referral: "0xC6666DB4Ee72eC9485664fa2D67113e4BE888a86",
    mining: "0x3A7B648752D3557C9770a56Fd3B471dB6ee8FE69",
    deflation: "0xED866239D6Fcd7164C54b3431f745850fACc60c1",
    // 第五套用 MockUSDT（非官方 USDT；测试钱包余额/授权均针对此地址）
    usdt: "0xe6d5879149078B7082567AF70319a16b7952CA8C",
  },
};

const BSC_MAINNET: ChainConfig = {
  name: "BSC",
  chainId: 56,
  rpc: "https://bsc-dataseed.binance.org",
  apiBase: "", // 上线后填 keeper API 地址
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
