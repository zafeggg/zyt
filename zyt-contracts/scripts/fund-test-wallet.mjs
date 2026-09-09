// 给任意测试账户充 testnet 资产：deployer 转 tBNB + MockERC20 faucet 领 MockUSDT
// 用法: node scripts/fund-test-wallet.mjs <地址> [tBNB=0.02] [USDT=2000]
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } from "ethers";
import "dotenv/config";
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const MOCK = "0x7749da5d64c0ABA2A8203c0C630d31e7D13cFb29";
const addr = process.argv[2];
if (!/^0x[0-9a-fA-F]{40}$/.test(addr || "")) { console.log("用法: node scripts/fund-test-wallet.mjs <钱包地址> [tBNB] [USDT]"); process.exit(1); }
const tBNB = parseEther(process.argv[3] || "0.02");
const usdtAmt = parseEther(process.argv[4] || "2000");
const p = new JsonRpcProvider(RPC, 97);
const deployer = new Wallet(process.env.PRIVATE_KEY, p);
console.log("deployer:", deployer.address, "tBNB:", formatEther(await p.getBalance(deployer.address)));
const db = await p.getBalance(deployer.address);
if (db < tBNB + parseEther("0.002")) { console.log("deployer tBNB 不足，请先给 deployer 充 testnet BNB（faucet: https://www.bnbchain.org/en/testnet-faucet）"); process.exit(1); }
let tx = await deployer.sendTransaction({ to: addr, value: tBNB });
await tx.wait();
console.log("① tBNB 转账 ok:", tx.hash, formatEther(tBNB));
const mock = new Contract(MOCK, ["function faucet(uint256)", "function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"], deployer);
tx = await mock.faucet(usdtAmt); // 用 deployer 代领（有 gas），转给目标
await tx.wait();
console.log("② faucet ok:", tx.hash, "（给", addr, "领取", formatEther(usdtAmt), "USDT 后转出）");
const mockFrom = new Contract(MOCK, ["function transfer(address,uint256)"], deployer);
tx = await mockFrom.transfer(addr, usdtAmt);
await tx.wait();
console.log("③ USDT 转出 ok:", tx.hash);
console.log("目标钱包 tBNB:", formatEther(await p.getBalance(addr)), "| USDT:", formatEther(await mock.balanceOf(addr)));
process.exit(0);
