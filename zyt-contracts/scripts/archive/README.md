# 归档脚本说明

本目录存放已完成历史使命或对当前版本（v9.1）失效的脚本，保留仅供追溯。

| 脚本 | 归档原因 | 当前替代 |
| -- | -- | -- |
| `toggle-whitelist-mainnet.mjs` | v8 的「用户买入白名单」机制（`buyWhitelistEnabled` / `buyWhitelist(address)`）在 v9 已移除 | v9 买入门控由三处构成：阶段（`poolStage1USDT`）、卖闸（ZYT 流入 pair 限 pool/creator）、买入闸（流出 pair 需 `swapGate`）。核对用 `scripts/post-deploy-check-mainnet.mjs` |

归档日期：2026-09-26
