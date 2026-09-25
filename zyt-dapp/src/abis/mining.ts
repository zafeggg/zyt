// 自动生成：contracts/ZYTMining.sol
// 由 scripts/gen-abis.mjs 生成，请勿手工编辑
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
    "name": "usdtIn",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "zytOut",
    "type": "uint256"
   }
  ],
  "name": "Bought",
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
    "name": "amount",
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
    "name": "day",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "totalPower",
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
    "name": "amount",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "fromDay",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "toDay",
    "type": "uint256"
   }
  ],
  "name": "DividendSettled",
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
  "name": "DynamicExited",
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
    "name": "usdtAmount",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "level",
    "type": "uint256"
   }
  ],
  "name": "RefPaid",
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
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "rate",
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
    "name": "zytAmount",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "usdtValue",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "bool",
    "name": "isOut",
    "type": "bool"
   }
  ],
  "name": "TransferLedger",
  "type": "event"
 },
 {
  "inputs": [],
  "name": "MAX_SETTLE_DAYS",
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
  "inputs": [
   {
    "internalType": "uint256",
    "name": "usdtIn",
    "type": "uint256"
   }
  ],
  "name": "buy",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "zytOut",
    "type": "uint256"
   }
  ],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "claimDividend",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   }
  ],
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
    "name": "dividendAmount",
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
    "internalType": "address",
    "name": "",
    "type": "address"
   }
  ],
  "name": "dividendClaimedDay",
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
  "inputs": [
   {
    "internalType": "address",
    "name": "user",
    "type": "address"
   }
  ],
  "name": "dividendOf",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "pending",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "settledDay",
    "type": "uint256"
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
  "inputs": [
   {
    "internalType": "uint256",
    "name": "day",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   }
  ],
  "name": "recordDailyDividend",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "user",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "zytAmount",
    "type": "uint256"
   }
  ],
  "name": "recordTransferIn",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "user",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "zytAmount",
    "type": "uint256"
   }
  ],
  "name": "recordTransferOut",
  "outputs": [],
  "stateMutability": "nonpayable",
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
  "inputs": [
   {
    "internalType": "address",
    "name": "user",
    "type": "address"
   }
  ],
  "name": "transferValueOf",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "receivedValue",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "withdrawCap",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
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
    "name": "power",
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
    "name": "buyQuotaLeft",
    "type": "uint256"
   },
   {
    "internalType": "bool",
    "name": "staticExited",
    "type": "bool"
   },
   {
    "internalType": "bool",
    "name": "dynamicExited",
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
    "name": "pendingDividend",
    "type": "uint256"
   },
   {
    "internalType": "bool",
    "name": "isExited",
    "type": "bool"
   },
   {
    "internalType": "uint256",
    "name": "receivedValue",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "exitDay",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "buyQuota",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "buyUsed",
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
    "internalType": "bool",
    "name": "dynamicExited",
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
];
