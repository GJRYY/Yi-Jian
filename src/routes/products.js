const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const { parseProductUrl } = require("../parsers");
const { parseHttpUrl, UnsafeUrlError } = require("../ssrf-guard");

const CARE_CODES = ["", "machine", "machineGentle", "dryClean", "wipe"];

// 商品结构化字段清单（统一数据结构，前端卡片 / 确认页 / 结果页共用）
const FIELD_LIMITS = {
  name: 200,
  price: 20,
  brand: 100,
  category: 100,
  color: 100,
  material: 200,
  fit: 100,
  style: 200,
  scenario: 200,
  season: 100,
  length: 100,
  care: 20,
  description: 2000,
  pros: 1000,
  risks: 1000,
  link: 2048,
  image: 2048,
};

function fieldType(key) {
  return key === "price" ? "number" : "string";
}

function normalizeField(key, value) {
  if (value == null) return "";
  if (key === "price") {
    const price = Number(value);
    if (!Number.isFinite(price)) return "";
    return price;
  }
  return String(value).trim().slice(0, FIELD_LIMITS[key] || 500);
}

function validatePrice(price) {
  return Number.isFinite(price) && price > 0 && price < 1e8;
}

function validateLink(rawLink) {
  const link = String(rawLink || "").trim();
  if (!link) return "";
  try {
    return parseHttpUrl(link).href;
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      const error = new Error(`商品链接不合法：${err.message}`);
      error.code = "INVALID_LINK";
      throw error;
    }
    throw err;
  }
}

function validateImage(image) {
  const value = String(image || "").trim();
  if (!value) return "";
  if (/^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return value;
    }
  } catch {
    // 落到下面的错误
  }
  const error = new Error("图片地址不合法");
  error.code = "INVALID_IMAGE";
  throw error;
}

function buildRecord(flat, options = {}) {
  const existing = options.existing || null;
  const autoFields = new Set(options.autoFields || []);
  const fields = {};

  for (const key of Object.keys(FIELD_LIMITS)) {
    const oldEntry = existing?.fields?.[key];

    // 未提交的字段保持原值（PATCH 局部更新）
    if (!(key in flat)) {
      fields[key] = oldEntry
        ? {
            value: oldEntry.value,
            source: oldEntry.source,
            confirmed: Boolean(oldEntry.confirmed),
          }
        : {
            value: key === "price" ? null : "",
            source: "user",
            confirmed: false,
          };
      continue;
    }

    const value = normalizeField(key, flat[key]);
    if (key === "price") {
      if (value === "" || !validatePrice(value)) {
        const error = new Error("价格必须是大于 0 的数字");
        error.code = "INVALID_PRICE";
        throw error;
      }
    }

    const changed = !oldEntry || String(oldEntry.value ?? "") !== String(value ?? "");
    let source = "user";
    if (oldEntry && !changed) {
      source = autoFields.has(key) ? "auto" : oldEntry.source;
    } else if (autoFields.has(key)) {
      source = "auto";
    }

    fields[key] = {
      value,
      source,
      confirmed: oldEntry && !changed ? Boolean(oldEntry.confirmed) : false,
    };
  }

  const link = validateLink(flat.link != null ? flat.link : existing?.link);
  const image = validateImage(flat.image != null ? flat.image : existing?.image);

  return {
    id: existing?.id || `p_${crypto.randomUUID()}`,
    link,
    image,
    source: existing?.source || "manual",
    confirmed: false,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fields,
  };
}

function presentProduct(record) {
  const value = (key) => {
    const entry = record.fields?.[key];
    if (!entry) return "";
    return entry.value == null || entry.value === "" ? "" : entry.value;
  };
  const care = value("care");
  const careLabelMap = {
    machine: "可机洗",
    machineGentle: "轻柔机洗",
    dryClean: "建议干洗",
    wipe: "擦拭清洁",
  };

  return {
    id: record.id,
    link: record.link || "",
    image: record.image || "",
    name: value("name"),
    brand: value("brand"),
    price: value("price"),
    category: value("category"),
    color: value("color"),
    material: value("material"),
    fit: value("fit"),
    style: value("style"),
    scenario: value("scenario"),
    season: value("season"),
    length: value("length"),
    care,
    careLabel: careLabelMap[care] || "待确认",
    description: value("description"),
    pros: value("pros"),
    risks: value("risks"),
    source: record.source,
    confirmed: Boolean(record.confirmed),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    fields: record.fields,
  };
}

module.exports = function productsRouter(store, config) {
  const router = express.Router();

  router.get("/", (req, res) => {
    res.json({ products: store.list().map(presentProduct) });
  });

  router.get("/:id", (req, res) => {
    const record = store.get(req.params.id);
    if (!record) {
      return res.status(404).json({
        error: { code: "PRODUCT_NOT_FOUND", message: "没有找到这件商品" },
      });
    }
    res.json({ product: presentProduct(record) });
  });

  router.post("/", (req, res) => {
    const flat = req.body || {};
    if (!String(flat.name || "").trim()) {
      return res.status(400).json({
        error: { code: "NAME_REQUIRED", message: "请填写商品名称" },
      });
    }
    try {
      const record = buildRecord(flat, { autoFields: req.body.autoFields });
      store.save(record);
      res.status(201).json({ product: presentProduct(record) });
    } catch (err) {
      return res.status(400).json({
        error: {
          code: err.code || "INVALID_PRODUCT",
          message: err.message || "商品资料不完整，请检查后重试",
        },
      });
    }
  });

  router.patch("/:id", (req, res) => {
    const existing = store.get(req.params.id);
    if (!existing) {
      return res.status(404).json({
        error: { code: "PRODUCT_NOT_FOUND", message: "没有找到这件商品" },
      });
    }
    const flat = req.body || {};
    const mergedName = flat.name != null ? flat.name : presentProduct(existing).name;
    if (!String(mergedName || "").trim()) {
      return res.status(400).json({
        error: { code: "NAME_REQUIRED", message: "请填写商品名称" },
      });
    }
    try {
      const record = buildRecord(flat, {
        existing,
        autoFields: req.body.autoFields,
      });
      store.save(record);
      res.json({ product: presentProduct(record) });
    } catch (err) {
      return res.status(400).json({
        error: {
          code: err.code || "INVALID_PRODUCT",
          message: err.message || "商品资料不完整，请检查后重试",
        },
      });
    }
  });

  router.delete("/:id", (req, res) => {
    const record = store.get(req.params.id);
    if (!record) {
      return res.status(404).json({
        error: { code: "PRODUCT_NOT_FOUND", message: "没有找到这件商品" },
      });
    }
    // 同时清理本地上传的图片（只允许删除 uploads 目录内的文件）
    if (/^\/uploads\/([A-Za-z0-9._-]+)$/.test(record.image || "")) {
      const fileName = record.image.replace("/uploads/", "");
      const target = path.join(config.uploadsDir, fileName);
      if (path.dirname(target) === config.uploadsDir) {
        try {
          fs.unlinkSync(target);
        } catch {
          // 文件不存在时忽略
        }
      }
    }
    store.remove(record.id);
    res.json({ deleted: true, id: record.id });
  });

  // 商品信息确认：只有确认后的商品才能进入决策分析
  router.post("/:id/confirm", (req, res) => {
    const record = store.get(req.params.id);
    if (!record) {
      return res.status(404).json({
        error: { code: "PRODUCT_NOT_FOUND", message: "没有找到这件商品" },
      });
    }
    const name = record.fields?.name?.value;
    const price = Number(record.fields?.price?.value);
    if (!String(name || "").trim()) {
      return res.status(400).json({
        error: { code: "NAME_REQUIRED", message: "请先填写商品名称再确认" },
      });
    }
    if (!validatePrice(price)) {
      return res.status(400).json({
        error: { code: "INVALID_PRICE", message: "请先填写大于 0 的价格再确认" },
      });
    }
    for (const key of Object.keys(record.fields || {})) {
      const entry = record.fields[key];
      if (
        entry &&
        entry.value != null &&
        String(entry.value).trim() !== ""
      ) {
        entry.confirmed = true;
      }
    }
    record.confirmed = true;
    record.updatedAt = new Date().toISOString();
    store.save(record);
    res.json({ product: presentProduct(record) });
  });

  // 商品链接解析（带 SSRF 防护，见 src/ssrf-guard.js 与 src/parsers）
  router.post("/parse-url", async (req, res) => {
    const rawUrl = String(req.body?.url || "").trim();
    if (!rawUrl) {
      return res.status(400).json({
        error: { code: "URL_REQUIRED", message: "请先粘贴商品链接" },
      });
    }
    const result = await parseProductUrl(rawUrl);
    if (result.status === "invalid" || result.status === "blocked") {
      return res.status(422).json({
        error: {
          code: result.status === "blocked" ? "UNSAFE_URL" : "INVALID_URL",
          message: result.message,
        },
      });
    }
    // failed / unsupported / partial / success 都返回 200，
    // 前端根据 status 展示可操作的状态（不中断整个流程）
    res.json(result);
  });

  return router;
};

