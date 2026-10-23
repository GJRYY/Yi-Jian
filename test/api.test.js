const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../src/app");
const { loadConfig } = require("../src/config");

// 1x1 透明 PNG
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3Q0dAQAAAABJRU5ErkJggg==",
  "base64",
);

let server;
let baseUrl;
let tempDir;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yijian-test-"));
  const config = { ...loadConfig(), port: 0, dataDir: tempDir, uploadsDir: path.join(tempDir, "uploads") };
  const app = createApp(config);
  await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

async function api(method, pathName, body) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

const BASE_PRODUCT = {
  name: "卡其风衣",
  price: 599,
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
  pros: "百搭耐穿",
  risks: "",
  link: "",
  image: "",
};

test("健康检查返回服务状态与 AI 配置状态", async () => {
  const { status, body } = await api("GET", "/api/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.ai.configured, false);
});

test("创建、修改、删除商品资料", async () => {
  const created = await api("POST", "/api/products", BASE_PRODUCT);
  assert.equal(created.status, 201);
  const id = created.body.product.id;
  assert.equal(created.body.product.name, "卡其风衣");
  assert.equal(created.body.product.confirmed, false);

  const patched = await api("PATCH", `/api/products/${id}`, { color: "深卡其" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.product.color, "深卡其");

  const got = await api("GET", `/api/products/${id}`);
  assert.equal(got.body.product.name, "卡其风衣");

  const deleted = await api("DELETE", `/api/products/${id}`);
  assert.equal(deleted.status, 200);
  const after = await api("GET", `/api/products/${id}`);
  assert.equal(after.status, 404);
});

test("拒绝缺少名称或非法价格的商品", async () => {
  const noName = await api("POST", "/api/products", { ...BASE_PRODUCT, name: " " });
  assert.equal(noName.status, 400);

  const badPrice = await api("POST", "/api/products", { ...BASE_PRODUCT, price: -3 });
  assert.equal(badPrice.status, 400);

  const badLink = await api("POST", "/api/products", { ...BASE_PRODUCT, link: "ftp://x" });
  assert.equal(badLink.status, 400);
});

test("未确认商品不能进入决策分析", async () => {
  const created = await api("POST", "/api/products", BASE_PRODUCT);
  const id = created.body.product.id;
  const result = await api("POST", "/api/decision/analyze", {
    productIds: [id],
    answers: { budget: "1000", budgetMode: "strict" },
  });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, "UNCONFIRMED_PRODUCTS");
  await api("DELETE", `/api/products/${id}`);
});

test("确认商品后决策分析使用真实商品数据", async () => {
  const a = await api("POST", "/api/products", { ...BASE_PRODUCT, price: 900 });
  const b = await api("POST", "/api/products", { ...BASE_PRODUCT, name: "蓝色牛仔夹克", price: 459 });
  const idA = a.body.product.id;
  const idB = b.body.product.id;
  await api("POST", `/api/products/${idA}/confirm`);
  await api("POST", `/api/products/${idB}/confirm`);

  const strictOver = await api("POST", "/api/decision/analyze", {
    productIds: [idA, idB],
    answers: { budget: "500", budgetMode: "strict" },
  });
  assert.equal(strictOver.status, 200);
  // 900 元那件超出严格预算被淘汰，459 元那件仍符合预算
  assert.equal(strictOver.body.type, "recommend");
  assert.equal(strictOver.body.keep.length, 1);
  assert.equal(strictOver.body.keep[0].id, idB);
  assert.equal(strictOver.body.totalPrice, 459);
  const overBudgetAnalysis = strictOver.body.analyses.find(
    (entry) => entry.product.id === idA,
  );
  assert.ok(
    overBudgetAnalysis.conflicts.some((item) => item.label === "预算"),
    "超预算商品的分析中应包含预算冲突",
  );

  const fits = await api("POST", "/api/decision/analyze", {
    productIds: [idA, idB],
    answers: { budget: "1000", budgetMode: "strict" },
  });
  assert.equal(fits.body.type, "recommend");
  assert.ok(fits.body.totalPrice <= 1000);
  assert.ok(
    fits.body.analyses.some((entry) => entry.product.id === idA),
    "分析结果应包含真实商品数据",
  );
  assert.equal(fits.body.comparison.length, 2);

  await api("DELETE", `/api/products/${idA}`);
  await api("DELETE", `/api/products/${idB}`);
});

test("上传合法图片成功并返回可访问地址", async () => {
  const form = new FormData();
  form.append("image", new Blob([PNG_BYTES], { type: "image/png" }), "test.png");
  const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.url, /^\/uploads\/.+\.png$/);
  const imageResponse = await fetch(`${baseUrl}${body.url}`);
  assert.equal(imageResponse.status, 200);
});

test("拒绝伪装成图片的非图片内容", async () => {
  const fake = Buffer.from("this is definitely not an image file at all");
  const form = new FormData();
  form.append("image", new Blob([fake], { type: "image/png" }), "fake.png");
  const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
  assert.equal(response.status, 400);
});

test("拒绝超过大小限制的上传", async () => {
  const big = Buffer.concat([PNG_BYTES, Buffer.alloc(6 * 1024 * 1024)]);
  const form = new FormData();
  form.append("image", new Blob([big], { type: "image/png" }), "big.png");
  const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "FILE_TOO_LARGE");
});

test("链接解析安全拒绝本机、内网与元数据地址", async () => {
  for (const url of [
    "http://127.0.0.1:3000/api/health",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.1.10/x",
  ]) {
    const result = await api("POST", "/api/products/parse-url", { url });
    assert.equal(result.status, 422, `应拒绝 ${url}`);
    assert.equal(result.body.error.code, "UNSAFE_URL");
  }
});

test("链接解析对需要登录的平台明确返回不支持，不伪装成功", async () => {
  const result = await api("POST", "/api/products/parse-url", {
    url: "https://item.taobao.com/item.htm?id=123",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "unsupported");
  assert.ok(result.body.message.includes("手动"), "应引导用户手动填写");
});

test("空链接与非法链接被拒绝", async () => {
  const empty = await api("POST", "/api/products/parse-url", { url: "" });
  assert.equal(empty.status, 400);
  const invalid = await api("POST", "/api/products/parse-url", { url: "这不是链接" });
  assert.equal(invalid.status, 422);
});

test("未配置模型时偏好提取接口返回明确状态", async () => {
  const result = await api("POST", "/api/preferences/extract", { text: "我想要一件百搭的风衣" });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "not_configured");
});

