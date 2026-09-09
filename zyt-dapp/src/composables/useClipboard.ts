/**
 * 剪贴板兼容层（v14）
 * - HTTPS / localhost：优先 navigator.clipboard（异步 API）
 * - HTTP 环境（如 testnet IP 直访）：navigator.clipboard 为 undefined，
 *   回退 document.execCommand("copy") + 临时 textarea（同步 API，仍被主流浏览器支持）
 * 返回布尔结果，调用方据此给成功/失败提示（禁止静默失败）
 */
export async function copyText(text: string): Promise<boolean> {
  // 1) 现代 API（仅 secure context 存在）
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落入 execCommand 回退 */
  }
  // 2) execCommand 回退（HTTP 环境兼容）
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
