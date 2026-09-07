// 生成专用 testnet 写链路测试钱包（deployer 转 gas + faucet MockUSDT）
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } from "ethers";
import "dotenv/config";
const RPC = "https://bsc-testnet-rpc.publicnode.com";
const MOCK = "0xe6d5879149078B7082567AF70319a16b7952CA8C";
const p = new JsonRpcProvider(RPC, 97);
const deployer = new Wallet(process.env.PRIVATE_KEY, p);
const w = Wallet.createRandom().connect(p);
console.log("新测试钱包地址:", w.address);
console.log("新测试钱包私钥:", w.privateKey);
const db = await p.getBalance(deployer.address);
console.log("deployer tBNB:", formatEther(db));
if (db < parseEther("0.02")) { console.log("余额不足"); process.exit(1); }
let tx = await deployer.sendTransaction({ to: w.address, value: parseEther("0.02") });
await tx.wait();
console.log("gas 转账 ok:", tx.hash);
const mock = new Contract(MOCK, ["function faucet(uint256)","function balanceOf(address) view returns (uint256)"], w);
tx = await mock.faucet(parseEther("2000"));
await tx.wait();
console.log("faucet 2000 USDT ok:", tx.hash);
console.log("新钱包 MockUSDT:", formatEther(await mock.balanceOf(w.address)));
console.log("新钱包 tBNB:", formatEther(await p.getBalance(w.address)));
process.exit(0);
