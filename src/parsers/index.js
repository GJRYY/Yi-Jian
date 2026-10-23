const { safeFetchText } = require("../ssrf-guard");

// 已知需要登录或反自动化机制的平台：不做匿名抓取，明确返回不支持，
// 引导用户走手动填写流程。未来可为各平台编写独立适配器（第二阶段起）。
const UNSUPPORTED_HOSTS = [
  "taobao.com",
  "tmall.com",
  "world.taobao.com",
  "1688.com",
  "xiaohongshu.com",
  "xhslink.com",
  "xhs.sh",
];

function hostBelongsTo(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function platformFor(hostname) {
  if (UNSUPPORTED_HOSTS.some((domain) => hostBelongsTo(hostname, domain))) {
    return {
      kind: "unsupported",
      hostname,
      message:
        "该平台（淘宝/天猫/1688/小红书）页面需要登录或存在反自动化机制，衣见不会尝试绕过。请直接上传商品截图或手动填写信息。",
    };
  }
  return { kind: "generic", hostname };
}

function firstDefined(...values) {
  return values.find((value) => value != null && String(value).trim() !== "");
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

function parsePrice(value) {
  if (value == null) return null;
  const match = String(value).match(/(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const price = Number(match[1]);
  if (!Number.isFinite(price) || price <= 0) return null;
  return Math.round(price * 100) / 100;
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["']`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// 从 <script type="application/ld+json"> 中提取第一个 Product 结构化数据。
function extractJsonLdProduct(html) {
  const scriptPattern =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates = Array.isArray(data) ? data : [data];
    for (const item of candidates) {
      if (item && typeof item === "object") {
        const types = Array.isArray(item["@type"])
          ? item["@type"]
          : [item["@type"]];
        if (types.includes("Product")) return item;
      }
    }
  }
  return null;
}

function parseGeneric(html) {
  const product = extractJsonLdProduct(html);
  const warnings = [];
  const fields = {};

  const title = cleanText(metaContent(html, "og:title")) || cleanText(
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1],
  );
  const ogImage = metaContent(html, "og:image");
  const description =
    cleanText(metaContent(html, "og:description")) ||
    cleanText(metaContent(html, "description"));

  let name = title || null;
  let image = ogImage || null;
  let price = null;
  let brand = null;
  let color = null;
  let material = null;

  if (product) {
    name = firstDefined(product.name, name);
    if (Array.isArray(product.image)) {
      image = firstDefined(product.image[0], image);
    } else {
      image = firstDefined(product.image, image);
    }
    if (typeof product.image === "object" && product.image && product.image.url) {
      image = product.image.url;
    }
    const offers = Array.isArray(product.offers)
      ? product.offers[0]
      : product.offers;
    if (offers && typeof offers === "object") {
      price = firstDefined(parsePrice(offers.price), price);
    }
    if (product.brand && typeof product.brand === "object") {
      brand = cleanText(product.brand.name);
    } else if (product.brand) {
      brand = cleanText(product.brand);
    }
    color = firstDefined(product.color, cleanText(product.material), null);
    material = firstDefined(product.material, null);
    const structuredDescription = firstDefined(product.description, null);
    if (structuredDescription) {
      // description 变量由 const 声明，这里直接写回字段
      fields.description = {
        value: cleanText(structuredDescription),
        source: "auto",
      };
    }
  }

  if (!product) {
    warnings.push("页面没有公开的结构化商品数据，只能从网页标题和描述中提取。");
  }
  if (title && !name) name = title;

  if (name) {
    fields.name = { value: cleanText(name).slice(0, 200), source: "auto" };
  }
  if (image) {
    try {
      const parsed = new URL(image, "https://placeholder.invalid");
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        fields.image = { value: parsed.href.slice(0, 2000), source: "auto" };
      }
    } catch {
      warnings.push("页面提供的图片地址无效，已忽略。");
    }
  }
  if (price != null) fields.price = { value: price, source: "auto" };
  if (brand) fields.brand = { value: brand.slice(0, 100), source: "auto" };
  if (color) fields.color = { value: cleanText(color).slice(0, 100), source: "auto" };
  if (material) {
    fields.material = { value: cleanText(material).slice(0, 200), source: "auto" };
  }
  if (description && !fields.description) {
    fields.description = { value: description.slice(0, 2000), source: "auto" };
  }

  const hasUseful = Object.keys(fields).length > 0;
  return {
    status: hasUseful ? (product ? "success" : "partial") : "failed",
    fields,
    warnings: hasUseful
      ? warnings
      : ["没有找到任何可用的商品信息，请手动填写。"],
  };
}

async function parseProductUrl(rawUrl) {
  // URL 合法性由 SSRF 防护统一检查（协议、长度等）
  const { safeFetchText: fetchText } = require("../ssrf-guard");
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    return {
      status: "invalid",
      message: "链接格式不正确，请检查后重试。",
      fields: {},
      warnings: [],
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      status: "invalid",
      message: "只支持 http 或 https 链接。",
      fields: {},
      warnings: [],
    };
  }

  const platform = platformFor(url.hostname);
  if (platform.kind === "unsupported") {
    return {
      status: "unsupported",
      platform,
      message: platform.message,
      fields: {},
      warnings: [],
    };
  }

  try {
    const { text, hostname, finalUrl } = await fetchText(url.href);
    const result = parseGeneric(text);
    return {
      ...result,
      platform: { kind: "generic", hostname, finalUrl },
    };
  } catch (err) {
    return {
      status: err.code === "UNSAFE_URL" ? "blocked" : "failed",
      code: err.code || "FETCH_FAILED",
      message: err.message || "页面读取失败",
      fields: {},
      warnings: [],
    };
  }
}

module.exports = { parseProductUrl, parseGeneric, platformFor };

