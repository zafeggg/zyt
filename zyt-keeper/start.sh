#!/usr/bin/env bash
# 众赢币 ZYT 链下服务启动脚本
# 作用：清除沙箱对 SQLite 文件的 append-only 标记，然后启动服务
cd "$(dirname "$0")"
chattr -a data/zyt.db data/zyt.db-wal data/zyt.db-shm 2>/dev/null
node src/index.js
