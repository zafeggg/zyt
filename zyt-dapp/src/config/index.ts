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
  rpc: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  apiBase: "", // testnet 部署后填 keeper API 地址
  contracts: {
    config: "",
    gst: "",
    zyt: "",
    forceSell: "",
    pool: "",
    referral: "",
    mining: "",
    deflation: "",
    usdt: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
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
