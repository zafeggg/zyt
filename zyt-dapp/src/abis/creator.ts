// 自动生成：contracts/ZYTLiquidityCreator.sol
// 由 scripts/gen-abis.mjs 生成，请勿手工编辑
export const CREATOR_ABI = [
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "zyt_",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "usdt_",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "factory_",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "blackHole_",
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
  "inputs": [],
  "name": "ReentrancyGuardReentrantCall",
  "type": "error"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "lpBurned",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "zytAmt",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "usdtAmt",
    "type": "uint256"
   }
  ],
  "name": "DeflationSkimmed",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "pair",
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
    "name": "usdtIn",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "liquidity",
    "type": "uint256"
   }
  ],
  "name": "InitialPoolCreated",
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
    "indexed": true,
    "internalType": "address",
    "name": "poolManager",
    "type": "address"
   }
  ],
  "name": "PoolManagerChanged",
  "type": "event"
 },
 {
  "inputs": [],
  "name": "blackHole",
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
    "name": "zytAmount",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "usdtAmount",
    "type": "uint256"
   }
  ],
  "name": "createInitialPool",
  "outputs": [
   {
    "internalType": "address",
    "name": "pairAddr",
    "type": "address"
   }
  ],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "factory",
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
  "name": "lockedLiquidity",
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
    "name": "",
    "type": "address"
   }
  ],
  "name": "lockedLpOf",
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
  "inputs": [],
  "name": "pair",
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
  "name": "poolManager",
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
  "name": "renounceOwnership",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "_pool",
    "type": "address"
   }
  ],
  "name": "setPoolManager",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "rateBps",
    "type": "uint256"
   }
  ],
  "name": "skimDeflation",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "zytAmt",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "usdtAmt",
    "type": "uint256"
   }
  ],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "totalDeflationUsdtOut",
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
  "name": "totalDeflationZytOut",
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
  "name": "totalUsdtSeeded",
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
  "name": "totalZytSeeded",
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
  "name": "zyt",
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
