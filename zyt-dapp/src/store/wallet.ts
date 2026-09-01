import { defineStore } from "pinia";

export const useWalletStore = defineStore("wallet", {
  state: () => ({
    address: "",
    chainId: 0,
  }),
  actions: {
    setAddress(addr: string) {
      this.address = addr;
    },
    setChainId(id: number) {
      this.chainId = id;
    },
    reset() {
      this.address = "";
    },
  },
});
