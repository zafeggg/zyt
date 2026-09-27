// SPDX-License-Identifier: MIT
/**
 * @notice 隐藏式终端输入（密码/私钥），双模式实现
 *
 * - TTY（真实用户）：readline 单例连续 question + _writeToOutput hack，输入回显 *
 * - 非 TTY（管道/自动化测试）：一次性预读 stdin 缓冲为行队列，question 依次出队
 *   （已踩坑：非 TTY 下反复创建或连续 question 会因流暂停竞态静默挂起，Node 22 Win 实测）
 *
 * 用毕调用 closePrompt() 释放 stdin，防事件循环悬挂不退出。
 */
"use strict";
const readline = require("node:readline");

const IS_TTY = process.stdin.isTTY === true;
let _rl = null;
let _currentQuestion = "";
let _pipeLines = null;

function _getRl() {
  if (_rl) return _rl;
  _rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: IS_TTY });
  if (IS_TTY) {
    _rl.output._writeToOutput = function _writeToOutput(stringToWrite) {
      if (
        stringToWrite.includes(_currentQuestion) ||
        stringToWrite === "\n" ||
        stringToWrite === "\r\n" ||
        stringToWrite === "\r"
      ) {
        _rl.output.write(stringToWrite);
      } else {
        _rl.output.write("*");
      }
    };
  }
  return _rl;
}

/** 非 TTY：首次调用一次性读尽 stdin（管道已 EOF，无竞态），后续逐行出队 */
function _pipeReadLine() {
  if (_pipeLines === null) {
    const fs = require("node:fs");
    const raw = fs.readFileSync(0, "utf8");
    _pipeLines = raw.split(/\r?\n/);
    while (_pipeLines.length && _pipeLines[_pipeLines.length - 1] === "") _pipeLines.pop();
  }
  return _pipeLines.length ? _pipeLines.shift() : "";
}

async function promptHidden(question) {
  _currentQuestion = question;
  if (!IS_TTY) {
    process.stdout.write(question);
    const v = (await _pipeReadLine()).trim();
    process.stdout.write("\n");
    return v;
  }
  const rl = _getRl();
  const answer = await new Promise((resolve) => rl.question(question, (v) => resolve(v.trim())));
  process.stdout.write("\n");
  return answer;
}

/** 全部提问结束后调用：释放 stdin，防事件循环悬挂不退出 */
function closePrompt() {
  if (_rl) {
    _rl.close();
    _rl = null;
  }
}

module.exports = { promptHidden, closePrompt, IS_TTY };
