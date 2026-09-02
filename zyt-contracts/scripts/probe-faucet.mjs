// 写链路测试资产准备核查：MockUSDT mint 能力 + 测试钱包余额
import { JsonRpcProvider, Contract } from "ethers";
const p = new JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com", 97);
const MOCK = "0xe6d5879149078B7082567AF70319a16b7952CA8C";
const WALLET = "0x2faef47130a0827ad98b920d2766c46229f92ec5";
const m = new Contract(MOCK, ["function balanceOf(address) view returns (uint256)","function mint(address,uint256)","function faucet(uint256)","function symbol() view returns (string)"], p);
const [bal, sym] = await Promise.all([m.balanceOf(WALLET), m.symbol()]);
console.log(`Mock(${sym}) balance of 0x2faE... =`, Number(bal)/1e18, `${sym}`);
const bnb = await p.getBalance(WALLET);
console.log("tBNB balance =", Number(bnb)/1e18, "tBNB");
// 检查用户钱包(如果有)也列出 — 探测 code 存在性以确认是 MockERC20
const code = await p.getCode(MOCK);
console.log("MockUSDT contract code length:", code.length, "(0x+66 = mock 简单合约? >200 = 真合约)");
// faucet 函数探测：看 ABI 编译产物里 MockERC20 有什么
