// 从用户确认的商品字段推导规则引擎所需的评分。
// 原则：只使用明确的关键词推导，推导不出来的保持「未知」，绝不编造。

const CARE_CODES = {
  machine: "可机洗",
  machineGentle: "轻柔机洗",
  dryClean: "建议干洗",
  wipe: "擦拭清洁",
};

const SCENARIO_KEYWORDS = {
  commute: ["通勤", "上班", "工作", "职场", "办公室"],
  casual: ["休闲", "日常", "逛街", "周末"],
  social: ["约会", "聚会", "社交", "拍照", "出片"],
  business: ["商务", "正式", "开会", "面试", "正装"],
  travel: ["旅行", "出游", "度假", "户外"],
  seasonal: ["换季", "秋冬", "保暖", "夏季", "春季", "春秋"],
  universal: ["百搭", "通用", "多场景", "万能"],
};

const SCENARIO_LABELS = {
  commute: "日常通勤",
  casual: "日常休闲",
  social: "约会或社交",
  business: "正式场合或商务活动",
  travel: "旅行出游",
  seasonal: "换季添置",
  universal: "多场景通用",
};

const FIT_EXTREME_KEYWORDS = ["修身", "紧身", "超宽松", "廓形", "oversize", "oversized"];

const TRENDY_KEYWORDS = ["潮流", "当季新款", "爆款", "联名", "y2k", "多巴胺", "辣妹"];

const DISCOMFORT_KEYWORDS = ["扎肤", "扎人", "粗糙", "刺痒", "偏硬"];

function hasKeyword(text, keywords) {
  const value = String(text || "").toLowerCase();
  return keywords.some((keyword) => value.includes(keyword.toLowerCase()));
}

function scenarioScoresFromText(text) {
  const value = String(text || "").trim();
  if (!value) return { scores: {}, matched: [], text: value };
  const matched = Object.entries(SCENARIO_KEYWORDS)
    .filter(([, keywords]) => hasKeyword(value, keywords))
    .map(([key]) => key);
  const scores = {};
  for (const key of matched) {
    scores[key] = key === "universal" ? 8 : 7;
  }
  return { scores, matched, text: value };
}

function careScore(care) {
  if (care === "machine") return 9;
  if (care === "machineGentle") return 8;
  if (care === "wipe") return 6;
  if (care === "dryClean") return 4;
  return null;
}

// 返回 null 表示该属性缺少足够依据，保持「未知」。
function deriveAttribute(key, product) {
  const style = String(product.style || "");
  const material = String(product.material || "");
  const fit = String(product.fit || "");
  const color = String(product.color || "");
  const season = String(product.season || "");
  const description = String(product.description || "");
  const care = String(product.care || "");

  switch (key) {
    case "versatile":
      if (hasKeyword(style + " " + description, ["百搭", "通勤", "基础款", "多场景", "经典"])) {
        return { score: 7, source: "infer", evidence: "风格描述包含百搭/通勤等关键词" };
      }
      if (hasKeyword(style, ["街头", "印花", "拼接", "复古"]) || hasKeyword(description, ["风格感强"])) {
        return { score: 5, source: "infer", evidence: "风格感较强，百搭程度需要留意" };
      }
      return null;
    case "texture":
      if (hasKeyword(material, ["羊毛", "羊绒", "真丝", "亚麻", "纯棉", "全棉", "呢"])) {
        return { score: 7, source: "infer", evidence: `材质描述包含 ${material.slice(0, 12)}` };
      }
      if (hasKeyword(material, ["聚酯", "涤纶", "化纤", "氨纶"])) {
        return { score: 4, source: "infer", evidence: `材质以 ${material.slice(0, 12)} 为主，质感可能一般` };
      }
      if (hasKeyword(material, ["牛仔", "皮革", "帆布"])) {
        return { score: 6, source: "infer", evidence: `材质为 ${material.slice(0, 12)}，耐穿但需保养` };
      }
      return null;
    case "comfort":
      if (hasKeyword(material, ["纯棉", "全棉", "针织", "羊绒", "莫代尔", "天丝"])) {
        return { score: 7, source: "infer", evidence: `材质 ${material.slice(0, 12)} 通常较舒适` };
      }
      if (hasKeyword(material, ["羊毛", "皮革", "牛仔", "帆布"])) {
        return { score: 5, source: "infer", evidence: `材质 ${material.slice(0, 12)} 可能偏硬或需适应` };
      }
      return null;
    case "fit":
      if (!fit) return null;
      return { score: 6, source: "detail", evidence: `版型描述：${fit}` };
    case "color":
      if (!color) return null;
      return { score: 6, source: "detail", evidence: `颜色：${color}` };
    case "design":
      if (hasKeyword(style + " " + description, ["设计感", "复古", "印花", "拼接", "格纹", "刺绣"])) {
        return { score: 7, source: "infer", evidence: "描述中有明显设计元素" };
      }
      if (hasKeyword(style, ["基础", "简约", "纯色"]) || hasKeyword(description, ["基础款", "简约款"])) {
        return { score: 5, source: "infer", evidence: "描述偏向基础简约" };
      }
      return null;
    case "care": {
      const score = careScore(care);
      if (score == null) return null;
      return { score, source: "detail", evidence: `洗护方式：${CARE_CODES[care] || care}` };
    }
    case "season":
      if (!season) return null;
      return { score: 6, source: "detail", evidence: `适用季节：${season}` };
    case "value":
      return null; // 性价比在引擎中结合价格中位数计算
    case "wardrobe":
      return null; // 与衣橱的搭配程度无法从商品本身判断
    default:
      return null;
  }
}

function deriveFlags(product) {
  const fit = String(product.fit || "");
  const style = String(product.style || "");
  const description = String(product.description || "");
  return {
    extremeFit: hasKeyword(fit, FIT_EXTREME_KEYWORDS) ? true : null,
    trendy: hasKeyword(style + " " + description, TRENDY_KEYWORDS) ? true : null,
    hardToMatch: hasKeyword(style, ["复古", "街头", "拼接", "印花"]) ? true : null,
    discomfortRisk: hasKeyword(description, DISCOMFORT_KEYWORDS) ? true : null,
  };
}

// 把存储层商品转换为引擎商品（带推导评分与来源标注）
function toEngineProduct(record) {
  const fields = record.fields || {};
  const value = (key) => {
    const entry = fields[key];
    if (!entry || entry.value == null || entry.value === "") return "";
    return entry.value;
  };

  const care = String(value("care") || "");
  const product = {
    id: record.id,
    name: value("name") || "未命名商品",
    brand: value("brand") || "用户商品",
    price: Number(value("price")) || 0,
    color: value("color"),
    style: value("style"),
    fit: value("fit"),
    length: value("length"),
    fabric: value("material"),
    material: value("material"),
    season: value("season"),
    category: value("category"),
    care,
    careLabel: CARE_CODES[care] || "待确认",
    image: record.image || "",
    link: record.link || "",
    description: value("description") || "",
    sells: String(value("pros") || "")
      .split(/[；;\n]+/)
      .map((item) => item.trim())
      .filter(Boolean),
    risks: String(value("risks") || "")
      .split(/[；;\n]+/)
      .map((item) => item.trim())
      .filter(Boolean),
    flags: deriveFlags({
      fit: value("fit"),
      style: value("style"),
      description: value("description"),
    }),
    wardrobeRisks: [],
    unknownDetails: [],
    derived: {},
  };

  const scenarioResult = scenarioScoresFromText(value("scenario"));
  product.scenarioScores = scenarioResult.scores;
  product.derived.scenario = scenarioResult;

  const attributeScores = {};
  const attributeSources = {};
  for (const key of [
    "versatile",
    "texture",
    "comfort",
    "fit",
    "color",
    "design",
    "care",
    "season",
    "value",
    "wardrobe",
  ]) {
    const derived = deriveAttribute(key, product);
    if (derived) {
      attributeScores[key] = derived.score;
      attributeSources[key] = { source: derived.source, evidence: derived.evidence };
    }
  }
  product.attributeScores = attributeScores;
  product.derived.attributes = attributeSources;

  // 未确认 / 缺失字段进入「未知信息」
  const fieldLabels = {
    name: "商品名称",
    price: "价格",
    category: "类别",
    color: "颜色",
    material: "材质",
    fit: "版型",
    style: "风格",
    scenario: "适用场景",
    season: "季节",
    length: "衣长",
    care: "洗护方式",
    brand: "品牌",
  };
  for (const [key, label] of Object.entries(fieldLabels)) {
    const entry = fields[key];
    if (!entry || !entry.confirmed || entry.value == null || String(entry.value).trim() === "") {
      product.unknownDetails.push(`${label}待确认`);
    }
  }
  product.unknownDetails.push("真实上身效果待确认");

  return product;
}

module.exports = {
  toEngineProduct,
  scenarioScoresFromText,
  deriveAttribute,
  deriveFlags,
  careScore,
  SCENARIO_LABELS,
  CARE_CODES,
};

