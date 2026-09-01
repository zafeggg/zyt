// 自动生成：contracts/ZYTMining.sol/ZYTMining.json
export const MINING_ABI = [
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "config_",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "pool_",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "referral_",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "zytToken_",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "usdt_",
    "type": "address"
   }
  ],
  "stateMutability": "nonpayable",
  "type": "constructor"
 },
 {
  "inputs": [],
  "name": "ReentrancyGuardReentrantCall",
  "type": "error"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "user",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "reward",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "day",
    "type": "uint256"
   }
  ],
  "name": "Claimed",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   }
  ],
  "name": "DailyReleaseAmountSet",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "day",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "totalPower",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "releaseAmount",
    "type": "uint256"
   }
  ],
  "name": "DailyReleased",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "user",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "usdt",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "zytMinted",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "power",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "quota",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "address",
    "name": "ref",
    "type": "address"
   }
  ],
  "name": "Deposited",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "user",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "usdt",
    "type": "uint256"
   }
  ],
  "name": "LiquidityAdded",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "receiver",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "reward",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "level",
    "type": "uint256"
   }
  ],
  "name": "RefReward",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "user",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "zytIn",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "usdtOut",
    "type": "uint256"
   }
  ],
  "name": "Sold",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "user",
    "type": "address"
   }
  ],
  "name": "StaticExited",
  "type": "event"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "usdtAmount",
    "type": "uint256"
   }
  ],
  "name": "addLiquidity",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "claimDividend",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "day",
    "type": "uint256"
   }
  ],
  "name": "claimReward",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "config",
  "outputs": [
   {
    "internalType": "contract ZYTConfig",
    "name": "",
    "type": "address"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "name": "dailyInfo",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "totalPower",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "releaseAmount",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "day",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "totalPower",
    "type": "uint256"
   }
  ],
  "name": "dailyRelease",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "dailyReleaseAmount",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "deflation",
  "outputs": [
   {
    "internalType": "address",
    "name": "",
    "type": "address"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "usdtAmount",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "ref",
    "type": "address"
   }
  ],
  "name": "deposit",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "name": "dividendClaimed",
  "outputs": [
   {
    "internalType": "bool",
    "name": "",
    "type": "bool"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "pool",
  "outputs": [
   {
    "internalType": "contract ZYTPoolManager",
    "name": "",
    "type": "address"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "user",
    "type": "address"
   }
  ],
  "name": "powerOf",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "referral",
  "outputs": [
   {
    "internalType": "contract ZYTReferral",
    "name": "",
    "type": "address"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "zytGross",
    "type": "uint256"
   }
  ],
  "name": "sellZyt",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   }
  ],
  "name": "setDailyReleaseAmount",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "_deflation",
    "type": "address"
   }
  ],
  "name": "setDeflation",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "usdt",
  "outputs": [
   {
    "internalType": "address",
    "name": "",
    "type": "address"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "user",
    "type": "address"
   }
  ],
  "name": "userInfo",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "depositTotal",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "withdrawTotal",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "dynamicQuota",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "dynamicWithdrawn",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "power",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "lpQuota",
    "type": "uint256"
   },
   {
    "internalType": "bool",
    "name": "isExited",
    "type": "bool"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "",
    "type": "address"
   }
  ],
  "name": "users",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "depositTotal",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "withdrawTotal",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "dynamicQuota",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "dynamicWithdrawn",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "powerBase",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "powerDay",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "lpQuota",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "pendingDividend",
    "type": "uint256"
   },
   {
    "internalType": "bool",
    "name": "isExited",
    "type": "bool"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "zytToken",
  "outputs": [
   {
    "internalType": "address",
    "name": "",
    "type": "address"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 }
] as const;
