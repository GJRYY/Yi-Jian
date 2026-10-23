const { test } = require("node:test");
const assert = require("node:assert/strict");

const { decide } = require("../src/rules/engine");
const { makeProducts, defaultAnswers } = require("./helpers");

test("单件商品也能给出推荐结论（不做虚假横向比较）", () => {
  const products = makeProducts([{ id: "p1", price: 500 }]);
  const result = decide(products, defaultAnswers({ budget: "800" }));
  assert.equal(result.type, "recommend");
  assert.equal(result.keep.length, 1);
  assert.equal(result.keep[0].id, "p1");
  assert.equal(result.totalPrice, 500);
  assert.equal(result.comparison.length, 0, "单件商品不应生成横向比较");
});

test("严格预算不满足时诚实拒绝，不生成推荐", () => {
  const products = makeProducts([
    { id: "p1", price: 600 },
    { id: "p2", price: 700 },
  ]);
  const result = decide(products, defaultAnswers({ budget: "500", budgetMode: "strict" }));
  assert.equal(result.type, "none");
  assert.equal(result.keep.length, 0);
  assert.equal(result.totalPrice, 0);
});

test("宽松预算允许 10% 以内超支，并给出明确提示", () => {
  const products = makeProducts([{ id: "p1", price: 540 }]);
  const result = decide(products, defaultAnswers({ budget: "500", budgetMode: "flexible" }));
  assert.equal(result.type, "recommend");
  assert.equal(result.isOverBudget, true);
  assert.equal(result.overAmount, 40);
});

test("宽松预算超出 10% 上限时不推荐", () => {
  const products = makeProducts([{ id: "p1", price: 560 }]);
  const result = decide(products, defaultAnswers({ budget: "500", budgetMode: "flexible" }));
  assert.equal(result.type, "none");
});

test("组合总价与预算剩余金额计算正确", () => {
  const products = makeProducts([
    { id: "p1", price: 300 },
    { id: "p2", price: 200 },
    { id: "p3", price: 150 },
  ]);
  const result = decide(products, defaultAnswers({ budget: "520", budgetMode: "strict" }));
  assert.equal(result.type, "recommend");
  assert.ok(result.totalPrice <= 520, "组合总价不能超过严格预算");
  const reasonText = result.reasons.join(" ");
  const match = reasonText.match(/剩余 ¥([\d,]+)/);
  assert.ok(match, "推荐理由中应包含剩余金额");
  assert.equal(Number(match[1].replaceAll(",", "")), 520 - result.totalPrice);
});

test("硬性条件「不接受只能干洗」会淘汰干洗商品", () => {
  const products = makeProducts([
    { id: "p1", price: 400, care: "dryClean" },
    { id: "p2", price: 420, care: "machine" },
  ]);
  const result = decide(
    products,
    defaultAnswers({ budget: "1000", dealbreakers: ["dryCleanOnly"] }),
  );
  assert.equal(result.type, "recommend");
  assert.deepEqual(result.keep.map((p) => p.id), ["p2"]);
});

test("所有商品都不满足条件时给出「不买」结论", () => {
  const products = makeProducts([
    { id: "p1", price: 400, care: "dryClean" },
    { id: "p2", price: 420, care: "dryClean" },
  ]);
  const result = decide(
    products,
    defaultAnswers({ budget: "1000", dealbreakers: ["dryCleanOnly"] }),
  );
  assert.equal(result.type, "none");
  assert.equal(result.keep.length, 0);
});

test("缺少关键资料的属性保持未知，不编造匹配", () => {
  const products = makeProducts([
    { id: "p1", price: 400, material: "", fit: "", style: "", scenario: "" },
  ]);
  const result = decide(
    products,
    defaultAnswers({
      budget: "1000",
      scenario: "business",
      priorities: ["texture", "fit"],
    }),
  );
  const analysis = result.analyses.find((entry) => entry.product.id === "p1");
  assert.ok(analysis);
  const textureItem = analysis.unknowns.some(
    (item) => item.label === "面料质感与耐穿程度" && item.status === "未知",
  );
  const scenarioItem = analysis.unknowns.some(
    (item) => item.label === "场景匹配" && item.status === "未知",
  );
  assert.ok(textureItem || analysis.unknowns.length > 0);
  assert.ok(scenarioItem);
});

test("无效预算返回 confirm 状态而不是编造结论", () => {
  const products = makeProducts([{ id: "p1", price: 400 }]);
  const result = decide(products, defaultAnswers({ budget: "0", budgetMode: "strict" }));
  assert.equal(result.type, "confirm");
});

test("不设预算上限时不因价格淘汰商品", () => {
  const products = makeProducts([{ id: "p1", price: 99999 }]);
  const result = decide(products, defaultAnswers({ budget: "100", budgetMode: "unlimited" }));
  assert.equal(result.type, "recommend");
  assert.equal(result.keep.length, 1);
});

