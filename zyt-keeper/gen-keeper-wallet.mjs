import { Wallet } from "ethers";
const w = Wallet.createRandom();
console.log("KEEPER_ADDRESS=" + w.address);
console.log("KEEPER_PRIVATE_KEY=" + w.privateKey);
