// 自动生成：contracts/ZYTPoolManager.sol/ZYTPoolManager.json
export const POOL_ABI = [
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "config_",
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
   },
   {
    "internalType": "address",
    "name": "gstToken_",
    "type": "address"
   }
  ],
  "stateMutability": "nonpayable",
  "type": "constructor"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "owner",
    "type": "address"
   }
  ],
  "name": "OwnableInvalidOwner",
  "type": "error"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "account",
    "type": "address"
   }
  ],
  "name": "OwnableUnauthorizedAccount",
  "type": "error"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "usdtIn",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "gstIn",
    "type": "uint256"
   }
  ],
  "name": "BuyRecorded",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "addr",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "bool",
    "name": "enabled",
    "type": "bool"
   }
  ],
  "name": "BuyWhitelistSet",
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
  "name": "DividendAccrued",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "previousOwner",
    "type": "address"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "newOwner",
    "type": "address"
   }
  ],
  "name": "OwnershipTransferred",
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
  "name": "PoolBurned",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "gst",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "zyt",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "usdt",
    "type": "uint256"
   }
  ],
  "name": "PoolInitialized",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "seller",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "zytGross",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "usdtOut",
    "type": "uint256"
   }
  ],
  "name": "SellSettled",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "rate",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "toMarket",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "toDividend",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "toBurn",
    "type": "uint256"
   }
  ],
  "name": "SlippageCollected",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "snapshotGST",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "snapshotPrice",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "time",
    "type": "uint256"
   }
  ],
  "name": "SnapshotUpdated",
  "type": "event"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "",
    "type": "address"
   }
  ],
  "name": "buyWhitelist",
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
  "inputs": [],
  "name": "dailyBurn",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "burned",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "dividend",
    "type": "uint256"
   }
  ],
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
  "inputs": [],
  "name": "dividendPool",
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
  "name": "getCurrentSlippage",
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
  "name": "getPrice",
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
  "name": "getStage",
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
  "name": "getTradePrice",
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
  "name": "gstToken",
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
    "name": "gstAmount",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "zytAmount",
    "type": "uint256"
   }
  ],
  "name": "initialize",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "initialized",
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
  "name": "lastSnapshotAt",
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
  "name": "mining",
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
  "inputs": [],
  "name": "owner",
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
   },
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   }
  ],
  "name": "payoutDividend",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "poolGST",
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
  "name": "poolUSDT",
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
  "name": "poolZYT",
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
  "name": "recordBuy",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "renounceOwnership",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "addr",
    "type": "address"
   },
   {
    "internalType": "bool",
    "name": "enabled",
    "type": "bool"
   }
  ],
  "name": "setBuyWhitelist",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address[]",
    "name": "addrs",
    "type": "address[]"
   },
   {
    "internalType": "bool",
    "name": "enabled",
    "type": "bool"
   }
  ],
  "name": "setBuyWhitelistBatch",
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
    "name": "_mining",
    "type": "address"
   }
  ],
  "name": "setMining",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "seller",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "zytGross",
    "type": "uint256"
   }
  ],
  "name": "settleSell",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "usdtOut",
    "type": "uint256"
   }
  ],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "snapshotPoolGST",
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
  "name": "snapshotPrice",
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
    "name": "newOwner",
    "type": "address"
   }
  ],
  "name": "transferOwnership",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "updateSnapshot",
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
