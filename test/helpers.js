const { toEngineProduct } = require("../src/rules/derive");

function makeRecord(overrides = {}) {
  const flat = {
    name: "测试风衣",
    price: 500,
    category: "外套",
    color: "卡其色",
    material: "纯棉",
    fit: "宽松",
    style: "通勤 / 百搭",
    scenario: "日常通勤",
    season: "春秋",
    length: "中长款",
    care: "machine",
    brand: "",
    description: "",
    pros: "",
    risks: "",
    link: "",
    image: "",
    ...overrides,
  };

  const fields = {};
  for (const [key, value] of Object.entries(flat)) {
    fields[key] = { value, source: "user", confirmed: true };
  }
  return {
    id: overrides.id || `p_test_${Math.random().toString(36).slice(2, 8)}`,
    link: flat.link,
    image: flat.image,
    source: "manual",
    confirmed: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fields,
  };
}

function makeProducts(list) {
  return list.map(makeRecord).map(toEngineProduct);
}

function defaultAnswers(overrides = {}) {
  return {
    scenario: "commute",
    frequency: "weekly2",
    concerns: [],
    concernNote: "",
    priorities: ["versatile", "value"],
    topPriority: "versatile",
    wardrobe: [],
    wardrobeNote: "",
    budget: "800",
    budgetMode: "strict",
    dealbreakers: [],
    dealbreakerNote: "",
    ...overrides,
  };
}

module.exports = { makeRecord, makeProducts, defaultAnswers };

