// 分发 TestUSDT + BNB gas 给测试钱包（主网试运行 2026-09-15）
// 用法: node scripts/distribute-testusdt.mjs <地址:usdt数量:bnb数量> ...
//   例: node scripts/distribute-testusdt.mjs 0x87C0...:2000:0.005 0xABC...:1000:0.003
// 无参数时默认给团队测试钱包 0x87C0（2000 TestUSDT + 0.005 BNB）
import { JsonRpcProvider, Wallet, Contract, parseEther, parseUnits, formatUnits, formatEther } from "ethers";
import "dotenv/config";

const RPC = process.env.BSC_MAINNET_RPC || "https://bsc-rpc.publicnode.com";
const p = new JsonRpcProvider(RPC, 56, { staticNetwork: true });
const owner = new Wallet(process.env.PRIVATE_KEY, p);
const USDT = "0x4cd6d10260Cdfc55A9dcf97dfffade73080E7608";
const usdt = new Contract(
  USDT,
  ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"],
  owner
);

const args = process.argv.slice(2);
const TARGETS = args.length
  ? args.map((s) => {
      const [addr, u = "2000", b = "0.005"] = s.split(":");
      return { addr, usdt: u, bnb: b };
    })
  : [{ addr: "0x87C0aF08c0F974E86CAC508faA239bB1Cc2f2241", usdt: "2000", bnb: "0.005" }];

console.log(
  "分发方:",
  owner.address,
  "| TestUSDT:",
  formatUnits(await usdt.balanceOf(owner.address), 18),
  "| BNB:",
  formatEther(await p.getBalance(owner.address))
);

for (const t of TARGETS) {
  const before = await usdt.balanceOf(t.addr);
  if (before === 0n) {
    const tx = await usdt.transfer(t.addr, parseUnits(t.usdt, 18));
    await tx.wait();
    console.log("✔ " + t.addr + "  +" + t.usdt + " TestUSDT  tx=" + tx.hash);
  } else {
    console.log("- " + t.addr + "  已有 TestUSDT " + formatUnits(before, 18) + "，跳过代币转账");
  }
  const bnbBal = await p.getBalance(t.addr);
  if (bnbBal < parseEther("0.001")) {
    const tx2 = await owner.sendTransaction({ to: t.addr, value: parseEther(t.bnb) });
    await tx2.wait();
    console.log("✔ " + t.addr + "  +" + t.bnb + " BNB(gas)  tx=" + tx2.hash);
  } else {
    console.log("- " + t.addr + "  已有 BNB " + formatEther(bnbBal) + "，跳过");
  }
  console.log(
    "  结果: TestUSDT " + formatUnits(await usdt.balanceOf(t.addr), 18) + " | BNB " + formatEther(await p.getBalance(t.addr))
  );
}
process.exit(0);
