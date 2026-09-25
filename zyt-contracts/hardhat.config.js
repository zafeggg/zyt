require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      // 移除显式 gas（显式 gasLimit 超过节点硬编码 tx cap 16.7M 会报错）；
      // 使用自动估算，估算值不超过 cap 即可
      allowUnlimitedContractSize: false,
      // 2026-09-25：blockGasLimit 显式设为 15M（< 节点 txGasCap 2^24=16.77M）。
      // 背景：deploy.js 在 localhost 下部分部署会走 fallback 路径取 blockGasLimit 作为 tx gasLimit，
      // 默认值偏高时抛 "gas limit exceeds transaction gas cap"。压低后本地端到端可稳定跑通。
      blockGasLimit: 15000000,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      // 同上：不显式传 gas，避免超过节点 tx gas cap
      allowUnlimitedContractSize: false,
      blockGasLimit: 15000000,
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      chainId: 97,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    bsc: {
      url: process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org",
      chainId: 56,
      // 私钥走 .env PRIVATE_KEY（仅本地/部署机持有，严禁上传服务器、严禁提交 Git）；
      // 主网部署需交互输入 yes 确认（deploy.js confirmMainnet），防误操作
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  // Etherscan V2 API 迁移（hardhat-verify 2.1.0+）：统一单一 apiKey，
  // per-network map 会走已废弃的 V1 端点（bscscan 报 "deprecated V1 endpoint"）
  etherscan: {
    apiKey: process.env.BSCSCAN_API_KEY || "",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
