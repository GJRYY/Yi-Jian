// 规则决策引擎（从 Demo 的 decide() 移植并适配真实商品）。
// 职责：可验证的计算 —— 预算、硬性限制、属性匹配、组合筛选、缺失信息识别。
// 语言解释由前端渲染；AI 个性化解释在第二阶段补充。

const { SCENARIO_LABELS } = require("./derive");

const PRIORITY_OPTIONS = [
  { value: "versatile", label: "百搭程度" },
  { value: "texture", label: "面料质感与耐穿程度" },
  { value: "comfort", label: "舒适度" },
  { value: "fit", label: "版型和剪裁" },
  { value: "color", label: "颜色与个人风格" },
  { value: "design", label: "设计感和独特性" },
  { value: "care", label: "好打理、洗护方便" },
  { value: "season", label: "保暖、轻便或季节适用性" },
  { value: "value", label: "性价比" },
  { value: "wardrobe", label: "与现有衣橱的搭配程度" },
];

const PRIORITY_LABELS = Object.fromEntries(
  PRIORITY_OPTIONS.map((option) => [option.value, option.label]),
);

const CONCERN_ATTRS = {
  looks: ["design", "color"],
  duplicate: ["wardrobe", "versatile"],
  price: ["value"],
  fit: ["fit", "season"],
  fabric: ["texture", "comfort", "season"],
  match: ["versatile", "wardrobe"],
  rare: ["value", "season"],
  need: ["value", "versatile"],
  other: [],
};

const BUDGET_MODE_LABELS = {
  strict: "严格控制",
  flexible: "可以小幅超出",
  unlimited: "不设预算上限",
};

const WARDROBE_OPTIONS = [
  { value: "similarColor", label: "有相似颜色" },
  { value: "similarFit", label: "有相似版型" },
  { value: "similarUse", label: "有相似用途" },
  { value: "manySimilar", label: "已经有很多同类衣服" },
  { value: "none", label: "没有类似款，正想补充一件" },
  { value: "unsure", label: "不太确定" },
];

function wardrobeLabel(value) {
  return WARDROBE_OPTIONS.find((option) => option.value === value)?.label || value;
}

function formatPrice(value) {
  return `¥${Number(value).toLocaleString("zh-CN")}`;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function average(values) {
  if (!values.length) return 5;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function combinations(items, size) {
  const result = [];
  const current = [];

  function walk(start) {
    if (current.length === size) {
      result.push([...current]);
      return;
    }
    for (let index = start; index <= items.length - (size - current.length); index += 1) {
      current.push(items[index]);
      walk(index + 1);
      current.pop();
    }
  }

  walk(0);
  return result;
}

function defaultAnswers() {
  return {
    scenario: "",
    frequency: "",
    concerns: [],
    concernNote: "",
    priorities: [],
    topPriority: "",
    wardrobe: [],
    wardrobeNote: "",
    budget: "700",
    budgetMode: "strict",
    dealbreakers: [],
    dealbreakerNote: "",
  };
}

function normalizeAnswers(answers) {
  const normalized = {
    ...defaultAnswers(),
    ...(answers || {}),
    concerns: (answers?.concerns || []).slice(0, 2),
    priorities: (answers?.priorities || []).slice(0, 3),
    wardrobe: [...(answers?.wardrobe || [])],
    dealbreakers: [...(answers?.dealbreakers || [])],
  };

  if (!BUDGET_MODE_LABELS[normalized.budgetMode]) normalized.budgetMode = "strict";
  if (!normalized.priorities.includes(normalized.topPriority)) {
    normalized.topPriority = normalized.priorities[0] || "";
  }
  return normalized;
}

function isBudgetValid(budget) {
  const parsed = Number(budget);
  return Number.isFinite(parsed) && parsed > 0;
}

function getBudgetLimit(budget, budgetMode, budgetValid) {
  if (budgetMode === "unlimited" || !budgetValid) return Infinity;
  return budgetMode === "flexible" ? budget * 1.1 : budget;
}

function buildContext(answers, products) {
  const normalized = normalizeAnswers(answers);
  const budget = Number(normalized.budget);
  const budgetValid = isBudgetValid(budget);
  const budgetMode = normalized.budgetMode;
  const budgetLimit = getBudgetLimit(budget, budgetMode, budgetValid);
  const prices = products.map((product) => product.price);
  const priceMedian =
    prices.length % 2
      ? prices[Math.floor(prices.length / 2)]
      : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;

  return {
    normalized,
    budget,
    budgetValid,
    budgetMode,
    budgetLimit,
    priceMedian,
    products,
  };
}

function scenarioInfo(product) {
  const derived = product.derived?.scenario;
  const scores = product.scenarioScores || {};
  const matched = derived?.matched || [];
  if (!derived || !derived.text || matched.length === 0) {
    return { known: false, scores, matched };
  }
  return { known: true, scores, matched };
}

// 结合价格中位数推导「性价比」，只在至少 2 件商品时进行
function valueScoreFor(product, context) {
  if (!context.products || context.products.length < 2) return null;
  const median = context.priceMedian;
  if (!median || !product.price) return null;
  if (product.price <= median * 0.8) {
    return { score: 7, source: "infer", evidence: "价格明显低于其他候选" };
  }
  if (product.price >= median * 1.2) {
    return { score: 4, source: "infer", evidence: "价格明显高于其他候选" };
  }
  return { score: 5, source: "infer", evidence: "价格处于候选商品的中等水平" };
}

function attributeValue(product, key, context) {
  if (key === "value") {
    return product.attributeScores.value != null
      ? {
          score: product.attributeScores.value,
          source: product.derived.attributes?.value?.source || "detail",
          evidence: product.derived.attributes?.value?.evidence || "",
        }
      : valueScoreFor(product, context);
  }
  if (product.attributeScores[key] == null) return null;
  const info = product.derived.attributes?.[key];
  return {
    score: product.attributeScores[key],
    source: info?.source || "detail",
    evidence: info?.evidence || "",
  };
}

function scoreProduct(product, context) {
  const normalized = context.normalized;
  const priorities = normalized.priorities.length
    ? normalized.priorities
    : ["versatile", "value"];

  let weighted = 0;
  let weightTotal = 0;
  let missing = false;

  for (const priority of priorities) {
    let weight = priority === normalized.topPriority ? 1.8 : 1;
    for (const concern of normalized.concerns) {
      const attrs = CONCERN_ATTRS[concern] || [];
      if (attrs.includes(priority)) weight += 0.35;
    }
    const info = attributeValue(product, priority, context);
    if (!info) {
      missing = true;
      continue;
    }
    weighted += info.score * weight;
    weightTotal += weight;
  }

  const preferenceScore = weightTotal ? weighted / weightTotal : 5;
  const scenario = scenarioInfo(product);
  const scenarioScore = scenario.known
    ? Math.max(...Object.values(scenario.scores), 5)
    : 5;
  const care = product.attributeScores.care ?? 5;
  const base = scenarioScore * 0.45 + preferenceScore * 0.45 + care * 0.1;

  // 信息不足时分数向中间值靠拢，避免把「未知」当成高分
  const confidenceDamp = missing ? (base - 5) * 0.35 : 0;

  let wardrobePenalty = 0;
  if (normalized.wardrobe.includes("manySimilar")) wardrobePenalty += 1.2;

  let frequencyPenalty = 0;
  if (
    normalized.frequency === "occasional" &&
    product.price >= context.priceMedian
  ) {
    frequencyPenalty = 0.4;
  }

  return round(base - confidenceDamp - wardrobePenalty - frequencyPenalty, 2);
}

function sourceLabel(source) {
  if (source === "detail") return "商品资料已确认";
  if (source === "auto") return "链接解析获取";
  if (source === "infer") return "根据描述推导";
  return "信息缺失";
}

function buildMatchItems(product, context) {
  const normalized = context.normalized;
  const items = [];

  const scenario = scenarioInfo(product);
  if (!scenario.known) {
    items.push({
      label: "场景匹配",
      status: "未知",
      source: "missing",
      evidence: "你没有填写适用场景，或填写的内容无法与预设场景对应",
    });
  } else {
    const score = product.scenarioScores[normalized.scenario] ?? 5;
    items.push({
      label: "场景匹配",
      status: score >= 7 ? "匹配" : score >= 5 ? "部分匹配" : "冲突",
      source: "infer",
      evidence: `适用场景标注：${scenario.matched
        .map((key) => SCENARIO_LABELS[key])
        .join("、")}`,
    });
  }

  for (const priority of normalized.priorities) {
    const info = attributeValue(product, priority, context);
    if (!info) {
      items.push({
        label: PRIORITY_LABELS[priority],
        status: "未知",
        source: "missing",
        evidence: "商品资料未提供足够依据，暂不猜测",
      });
    } else {
      items.push({
        label: PRIORITY_LABELS[priority],
        status: info.score >= 7 ? "匹配" : info.score <= 4 ? "冲突" : "部分匹配",
        source: info.source,
        evidence: info.evidence,
      });
    }
  }

  // 衣橱相关判断：无法从商品本身知道你衣橱里有什么，保持诚实
  if (normalized.wardrobe.includes("none")) {
    items.push({
      label: "衣橱重复",
      status: "匹配",
      source: "infer",
      evidence: "你说衣橱中没有类似款，正想补充一件",
    });
  } else if (normalized.wardrobe.includes("unsure")) {
    items.push({
      label: "衣橱重复",
      status: "未知",
      source: "missing",
      evidence: "你还不确定现有衣橱是否相似，建议翻看后确认",
    });
  } else if (normalized.wardrobe.includes("manySimilar")) {
    items.push({
      label: "衣橱重复",
      status: "冲突",
      source: "infer",
      evidence: "你说已经有很多同类衣服，先确认这件是否真的缺",
    });
  } else if (normalized.wardrobe.length) {
    items.push({
      label: "衣橱重复",
      status: "未知",
      source: "missing",
      evidence: "你提到有相似款（颜色/版型/用途），但具体是否重复需要你对照衣橱确认",
    });
  } else {
    items.push({
      label: "衣橱重复",
      status: "部分匹配",
      source: "infer",
      evidence: "你未提及衣橱中有相似款",
    });
  }

  if (normalized.dealbreakers.includes("machineWashPreferred")) {
    if (product.care === "machine" || product.care === "machineGentle") {
      items.push({
        label: "希望方便机洗",
        status: "匹配",
        source: "detail",
        evidence: `洗护方式：${product.careLabel}`,
      });
    } else if (product.care === "dryClean" || product.care === "wipe") {
      items.push({
        label: "希望方便机洗",
        status: "冲突",
        source: "detail",
        evidence: `洗护方式：${product.careLabel}`,
      });
    } else {
      items.push({
        label: "希望方便机洗",
        status: "未知",
        source: "missing",
        evidence: "洗护方式未确认",
      });
    }
  }

  if (normalized.dealbreakers.includes("dryCleanOnly") && product.care === "dryClean") {
    items.push({
      label: "不接受只能干洗",
      status: "冲突",
      source: "detail",
      evidence: `洗护方式：${product.careLabel}`,
    });
  }

  const flagChecks = [
    ["hardToMatch", "不想买难以搭配的款式", "风格感较强，可能有搭配门槛"],
    ["trendy", "不想买太容易过时的款式", "描述提示它有较强潮流属性"],
    ["extremeFit", "不能接受过于宽松或过于修身的版型", `版型描述：${product.fit || "未提供"}`],
    ["discomfort", "不喜欢扎肤或明显不舒适的面料", "描述提示可能有明显不舒适风险"],
  ];

  for (const [dealbreaker, label, conflictEvidence] of flagChecks) {
    if (!normalized.dealbreakers.includes(dealbreaker)) continue;
    const flag = product.flags[dealbreaker];
    if (flag === true) {
      items.push({
        label,
        status: "冲突",
        source: "infer",
        evidence: conflictEvidence,
      });
    } else {
      items.push({
        label,
        status: "未知",
        source: "missing",
        evidence: "商品资料不足以判断，建议查看详情或试穿确认",
      });
    }
  }

  if (normalized.dealbreakers.includes("lengthMobility")) {
    items.push({
      label: "长度或活动便利性有明确要求",
      status: "未知",
      source: "missing",
      evidence: "商品资料未给出长度或活动便利性的量化信息，需要确认",
    });
  }

  if (normalized.dealbreakers.includes("temperature")) {
    items.push({
      label: "需要适合特定温度或季节",
      status: "未知",
      source: "missing",
      evidence: "你没有写明具体温度或季节，商品资料也缺少量化指标",
    });
  }

  if (
    normalized.budgetMode !== "unlimited" &&
    context.budgetValid &&
    product.price > context.budgetLimit
  ) {
    items.push({
      label: "预算",
      status: "冲突",
      source: "detail",
      evidence: `价格 ${formatPrice(product.price)} 超出预算限制`,
    });
  }

  return items;
}

function evaluateProducts(context) {
  const normalized = context.normalized;

  return context.products.map((product) => {
    const blockReasons = [];

    if (
      normalized.budgetMode !== "unlimited" &&
      context.budgetValid &&
      product.price > context.budgetLimit
    ) {
      blockReasons.push(
        normalized.budgetMode === "strict"
          ? `超出总预算 ${formatPrice(context.budget)}`
          : "超出预算 10% 的可接受范围",
      );
    }

    if (
      normalized.dealbreakers.includes("dryCleanOnly") &&
      product.care === "dryClean"
    ) {
      blockReasons.push("只能干洗，不符合你的要求");
    }
    if (
      normalized.dealbreakers.includes("machineWashPreferred") &&
      product.care !== "machine" &&
      product.care !== "machineGentle" &&
      product.care !== ""
    ) {
      blockReasons.push("洗护方式不满足「方便机洗」的要求");
    }
    for (const flag of ["hardToMatch", "trendy", "extremeFit", "discomfort"]) {
      if (normalized.dealbreakers.includes(flag) && product.flags[flag] === true) {
        blockReasons.push("商品资料提示存在你不接受的情况");
      }
    }

    const matchItems = buildMatchItems(product, context);
    const conflicts = matchItems.filter((item) => item.status === "冲突");
    const unknowns = matchItems.filter((item) => item.status === "未知");

    return {
      product,
      blockReasons,
      eligible: blockReasons.length === 0,
      score: scoreProduct(product, context),
      matchItems,
      conflicts,
      unknowns,
    };
  });
}

function buildCandidates(evaluated, context) {
  const eligible = evaluated.filter((entry) => entry.eligible);
  const { budget, budgetValid, budgetMode, budgetLimit, normalized } = context;
  const candidates = [];

  for (let size = 1; size <= 2; size += 1) {
    const groups = combinations(eligible, size);

    for (const group of groups) {
      const totalPrice = group.reduce((sum, entry) => sum + entry.product.price, 0);
      if (budgetMode !== "unlimited" && budgetValid && totalPrice > budgetLimit) {
        continue;
      }

      const baseScore = group.reduce((sum, entry) => sum + entry.score, 0);
      const uniqueTypes = new Set(
        group.map((entry) => entry.product.category || entry.product.style),
      );
      const diversityBonus =
        group.length > 1 && uniqueTypes.size > 1 ? 0.8 : 0;
      const sameTypePenalty =
        group.length > 1 ? (group.length - uniqueTypes.size) * -0.6 : 0;

      const overAmount =
        budgetMode === "flexible" && budgetValid
          ? Math.max(totalPrice - budget, 0)
          : 0;
      const overRatio = budget > 0 ? overAmount / budget : 0;
      const isOverBudget = overAmount > 0;

      let budgetAdjust = 0;
      if (budgetMode === "strict" && budgetValid) {
        budgetAdjust = clamp(((budget - totalPrice) / budget) * 1.2, 0, 1.2);
      } else if (budgetMode === "flexible" && budgetValid) {
        budgetAdjust = isOverBudget
          ? -overRatio * 10
          : clamp(((budget - totalPrice) / budget) * 0.8, 0, 0.8);
      }

      candidates.push({
        entries: group,
        items: group.map((entry) => entry.product),
        totalPrice,
        score: round(
          baseScore +
            sameTypePenalty +
            diversityBonus +
            budgetAdjust,
          2,
        ),
        budgetMode,
        budgetLimit,
        isOverBudget,
        overAmount,
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function buildKeyReasons(best, context) {
  if (!best.items.length) {
    return [
      "你比较的商品都踩中了至少一个硬性条件，与其将就，不如先都不买。",
      "你最看重的需求和这些商品没有形成明确匹配，硬留一件很可能后悔。",
      "清空购物车不是失败，说明这次筛选帮你省下了一次不必要的下单。",
    ];
  }

  const { normalized, budget, budgetValid, budgetMode } = context;
  const keep = best.items;
  const factorText = normalized.priorities.length
    ? normalized.priorities.map((priority) => PRIORITY_LABELS[priority]).join("和")
    : "通用需求";
  const total = best.totalPrice;
  const remaining = budgetValid ? budget - total : 0;
  const scenarioLabel =
    SCENARIO_LABELS[normalized.scenario] || "日常";

  let budgetReason = "这套组合没有触碰你设定的硬性条件。";
  if (budgetMode === "strict" && budgetValid) {
    budgetReason = `总价 ${formatPrice(total)} 在 ${formatPrice(budget)} 预算内，剩余 ${formatPrice(remaining)}。`;
  } else if (budgetMode === "flexible" && budgetValid) {
    budgetReason = best.isOverBudget
      ? `总价 ${formatPrice(total)}，比预算 ${formatPrice(budget)} 超出 ${formatPrice(best.overAmount)}，仍在 10% 容忍范围内。`
      : `总价 ${formatPrice(total)} 在 ${formatPrice(budget)} 预算内，剩余 ${formatPrice(remaining)}。`;
  } else if (budgetMode === "unlimited") {
    budgetReason = budgetValid
      ? `总价 ${formatPrice(total)}，本次不设预算上限，${formatPrice(budget)} 仅作参考。`
      : `总价 ${formatPrice(total)}，本次不设预算上限。`;
  }

  return [
    keep.length === 1
      ? `${keep[0].name}在你选择的${scenarioLabel}场景里最不容易出错。`
      : `这两件在${scenarioLabel}场景里互补，而不是简单重复。`,
    `你优先看重的${factorText}，${keep.length === 1 ? "它整体接得住" : "这套组合能接住"}。`,
    budgetReason,
  ];
}

function buildProductFields(product) {
  const text = (value) => (value ? String(value) : "");
  const fields = [
    {
      label: "商品名称",
      value: text(product.name),
      source: product.name ? "detail" : "missing",
    },
    {
      label: "价格",
      value: product.price ? formatPrice(product.price) : "",
      source: product.price ? "detail" : "missing",
    },
    {
      label: "颜色与风格",
      value: [text(product.color), text(product.style)].filter(Boolean).join(" · "),
      source: product.color || product.style ? "detail" : "missing",
    },
    {
      label: "版型、剪裁和衣长",
      value: [text(product.fit), text(product.length)].filter(Boolean).join(" · "),
      source: product.fit || product.length ? "detail" : "missing",
    },
    {
      label: "面料成分及材质",
      value: text(product.fabric),
      source: product.fabric ? "detail" : "missing",
    },
    {
      label: "适用季节与场景",
      value: [text(product.season), text(product.derived?.scenario?.text || "")].filter(Boolean).join(" · "),
      source: product.season || product.derived?.scenario?.text ? "detail" : "missing",
    },
    {
      label: "洗护方式",
      value: text(product.careLabel),
      source: product.care ? "detail" : "missing",
    },
    {
      label: "主要卖点",
      value: product.sells.join("；"),
      source: product.sells.length ? "detail" : "missing",
    },
    {
      label: "需要权衡的地方",
      value: product.risks.join("；"),
      source: product.risks.length ? "detail" : "missing",
    },
    {
      label: "来源链接",
      value: text(product.link),
      source: product.link ? "detail" : "missing",
    },
  ];
  return fields.filter((field) => field.value);
}

function buildAnalysis(entry, context) {
  const product = entry.product;
  const fields = buildProductFields(product);
  const knownMatches = entry.matchItems.filter(
    (item) => item.status !== "未知" && item.status !== "冲突",
  );
  const conflicts = entry.conflicts;
  const unknowns = [...entry.unknowns];

  for (const detail of product.unknownDetails) {
    if (!unknowns.some((item) => item.label === detail)) {
      unknowns.push({
        label: detail,
        status: "未知",
        source: "missing",
        evidence: "商品资料未提供",
      });
    }
  }

  const matchPercent = clamp(Math.round((entry.score / 9.5) * 100), 0, 100);

  return {
    product,
    excerpt: product.description || "用户添加的商品，暂未提供详细描述。",
    fields,
    matches: knownMatches,
    conflicts,
    unknowns,
    matchPercent,
  };
}

function buildComparison(analyses, keptIds) {
  return analyses.map((analysis) => {
    const product = analysis.product;
    const isKeep = keptIds.includes(product.id);
    const conflictText =
      analysis.conflicts[0]?.label || analysis.conflicts[0]?.evidence || "暂无硬性冲突";
    const riskText = product.risks[0] || "暂无明确风险";
    const unknownText = analysis.unknowns[0]?.label || "暂无未知项";

    return {
      product,
      isKeep,
      matchPercent: analysis.matchPercent,
      bestReason: product.sells[0] || "用户未填写主要优势",
      risk: riskText,
      difference: isKeep
        ? "综合匹配更接近你的需求"
        : conflictText !== "暂无硬性冲突"
          ? `主要冲突：${conflictText}`
          : "相对其他商品优势不够突出",
      unknown: unknownText,
      final: isKeep ? "留下" : "淘汰",
    };
  });
}

function emptyResult(type, headline, detail, summary, extra = {}) {
  return {
    type,
    headline,
    detail,
    keep: [],
    totalPrice: 0,
    reasons: [],
    analyses: [],
    comparison: [],
    summary,
    ...extra,
  };
}

// 主入口：products 是引擎商品数组（已确认），answers 是用户需求
function decide(products, answers) {
  if (!Array.isArray(products) || products.length < 1) {
    return emptyResult(
      "confirm",
      "还需要先添加商品",
      "请先添加并确认至少一件商品，我才能帮你分析。",
      "返回商品页面添加商品。",
    );
  }
  if (products.length > 4) {
    return emptyResult(
      "confirm",
      "一次最多比较 4 件",
      "请先去掉一些商品，一次最多比较 4 件。",
      "请返回商品页面调整后再试。",
    );
  }

  const context = buildContext(answers, products);
  const evaluated = evaluateProducts(context);
  const eligible = evaluated.filter((entry) => entry.eligible);
  const candidates = buildCandidates(evaluated, context);
  const needsBudget = context.budgetMode !== "unlimited";

  if (needsBudget && !context.budgetValid) {
    return {
      ...emptyResult(
        "confirm",
        "我还差一个关键信息",
        "总预算还没填清楚，先确认金额我再帮你算。",
        "确认预算后，我才能继续做组合筛选。",
      ),
      analyses: evaluated.map((entry) => buildAnalysis(entry, context)),
      comparison:
        evaluated.length > 1
          ? buildComparison(
              evaluated.map((entry) => buildAnalysis(entry, context)),
              [],
            )
          : [],
    };
  }

  if (eligible.length === 0) {
    const analyses = evaluated.map((entry) => buildAnalysis(entry, context));
    return {
      ...emptyResult(
        "none",
        "这次我建议你一件都别留",
        "不是替你省钱，是这些商品都不够合适。",
        "购物车里的选择可以先放一放。你没有为不合适的商品将就，这比买错更划算。",
      ),
      budgetMode: context.budgetMode,
      budgetLimit: context.budgetLimit,
      isOverBudget: false,
      overAmount: 0,
      reasons: buildKeyReasons({ items: [], totalPrice: 0 }, context),
      analyses,
      comparison: analyses.length > 1 ? buildComparison(analyses, []) : [],
    };
  }

  const best = candidates[0];
  if (!best) {
    const analyses = evaluated.map((entry) => buildAnalysis(entry, context));
    return {
      ...emptyResult(
        "none",
        "这次我建议你一件都别留",
        "符合条件的组合暂时没有找到。",
        "先不买，等你补充更多信息后再比较。",
      ),
      budgetMode: context.budgetMode,
      budgetLimit: context.budgetLimit,
      isOverBudget: false,
      overAmount: 0,
      reasons: buildKeyReasons({ items: [], totalPrice: 0 }, context),
      analyses,
      comparison: analyses.length > 1 ? buildComparison(analyses, []) : [],
    };
  }

  const analyses = evaluated.map((entry) => buildAnalysis(entry, context));
  const keptIds = best.items.map((item) => item.id);

  return {
    type: "recommend",
    headline:
      best.items.length === 1 ? "我建议你只留下这一件" : "这两件可以一起留",
    detail:
      best.items.length === 1
        ? "就买最不会后悔的那件。"
        : "先看总价和重复风险，再决定要不要都留。",
    keep: best.items,
    totalPrice: best.totalPrice,
    budgetMode: best.budgetMode,
    budgetLimit: best.budgetLimit,
    isOverBudget: best.isOverBudget,
    overAmount: best.overAmount,
    reasons: buildKeyReasons(best, context),
    analyses,
    comparison: analyses.length > 1 ? buildComparison(analyses, keptIds) : [],
    summary:
      best.items.length === 1
        ? "先留下最匹配你需求的那件。其他商品不是不好，只是在这次场景里不如它更值得。"
        : "这两件可以互相补充，但下单前先确认你是否真的需要同时留下，而不是为了“两件更划算”勉强凑单。",
  };
}

module.exports = {
  decide,
  buildContext,
  evaluateProducts,
  buildCandidates,
  buildMatchItems,
  buildAnalysis,
  buildComparison,
  normalizeAnswers,
  sourceLabel,
  formatPrice,
  wardrobeLabel,
};

