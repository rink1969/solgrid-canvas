// 把平台原始错误翻译成可操作提示；不改变真实错误文本。
export function runErrorHint(message?: string | null): string | null {
    const text = String(message || "");
    if (!text.trim()) return null;
    if (/daily[_\s-]?budget|budget|quota|insufficient|余额|额度/i.test(text)) return "平台额度不足：请调整 solgrid 日预算，或稍后重试。";
    if (/unauthor|unauth|invalid.*(token|key)|401|登录|credential/i.test(text)) return "solgrid 登录或凭证失效：请在终端重新登录 solgrid。";
    if (/timeout|timed out|504|520|cloudflare/i.test(text)) return "平台或端点超时：可稍后重试；连续失败建议换模型。";
    if (/unavailable|not found|404|invocationenabled|暂不可用/i.test(text)) return "端点当前不可用：用 canvas_list_tools 查看 invocationEnabled，换一个可用端点。";
    if (/invalid|参数|422|schema|required/i.test(text)) return "参数不符合端点契约：用 canvas_inspect_tool 检查 required 字段。";
    return null;
}
