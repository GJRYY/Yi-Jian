const dns = require("node:dns").promises;
const net = require("node:net");

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 512 * 1024;
const TIMEOUT_MS = 9000;

class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.code = "UNSAFE_URL";
  }
}

class FetchFailedError extends Error {
  constructor(message, code = "FETCH_FAILED") {
    super(message);
    this.code = code;
  }
}

function isIpLiteral(hostname) {
  return net.isIP(hostname.replace(/^\[|\]$/g, "")) !== 0;
}

function isPrivateIp(ip) {
  if (ip.includes(":")) {
    // IPv6
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10
    if (lower.startsWith("ff")) return true; // 组播
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice("::ffff:".length);
      return isPrivateIpv4(v4);
    }
    return false;
  }
  return isPrivateIpv4(ip);
}

function isPrivateIpv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // 解析异常一律拒绝
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT
  if (a === 169 && b === 254) return true; // 链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24，含 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a >= 224) return true; // 组播与保留段
  return false;
}

const BLOCKED_HOSTNAME_SUFFIXES = [
  "localhost",
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".lan",
];

function isBlockedHostname(hostname) {
  const lower = hostname.toLowerCase();
  if (lower === "metadata.google.internal" || lower === "instance-data") return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some(
    (suffix) => lower === suffix.slice(1) || lower.endsWith(suffix),
  );
}

function parseHttpUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new UnsafeUrlError("链接不能为空");
  }
  if (raw.length > 2048) {
    throw new UnsafeUrlError("链接过长");
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("链接格式不正确");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("只支持 http 或 https 链接");
  }
  if (!url.hostname) {
    throw new UnsafeUrlError("链接缺少域名");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("链接中不能包含账号密码");
  }
  return url;
}

async function assertSafeHostname(hostname) {
  if (isBlockedHostname(hostname)) {
    throw new UnsafeUrlError("该地址不允许访问");
  }
  if (isIpLiteral(hostname)) {
    const ip = hostname.replace(/^\[|\]$/g, "");
    if (isPrivateIp(ip)) {
      throw new UnsafeUrlError("不能访问本机、内网或元数据地址");
    }
    return;
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new FetchFailedError("域名无法解析", "DNS_FAILED");
  }
  if (!addresses.length) {
    throw new FetchFailedError("域名无法解析", "DNS_FAILED");
  }
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new UnsafeUrlError("该域名解析到不允许访问的地址");
  }
}

async function safeFetchText(rawUrl) {
  let current = parseHttpUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertSafeHostname(current.hostname);

    let response;
    try {
      response = await fetch(current.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; YijianBot/0.2; +local shopping helper)",
          accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (err) {
      const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new FetchFailedError(
        timedOut ? "请求超时，该页面暂时无法读取" : "无法访问该链接，请确认链接有效",
        timedOut ? "TIMEOUT" : "NETWORK_ERROR",
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new FetchFailedError("页面发生了无法跟随的跳转", "REDIRECT_FAILED");
      }
      current = parseHttpUrl(new URL(location, current.href).href);
      continue;
    }

    if (response.status === 403 || response.status === 401) {
      throw new FetchFailedError("该页面需要登录或拒绝访问，请手动补充商品信息", "ACCESS_DENIED");
    }
    if (response.status >= 400) {
      throw new FetchFailedError(`页面返回了异常状态（${response.status}）`, "HTTP_STATUS");
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml") &&
      contentType !== ""
    ) {
      throw new FetchFailedError("该链接不是网页，无法从中提取商品信息", "NOT_HTML");
    }

    // 限制响应体大小，防止内存被大文件占满
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new FetchFailedError("页面过大，无法完整读取", "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return { text, finalUrl: current.href, hostname: current.hostname };
  }

  throw new FetchFailedError("页面跳转次数过多，已停止跟随", "TOO_MANY_REDIRECTS");
}

module.exports = {
  parseHttpUrl,
  assertSafeHostname,
  safeFetchText,
  isPrivateIp,
  isBlockedHostname,
  UnsafeUrlError,
  FetchFailedError,
};

