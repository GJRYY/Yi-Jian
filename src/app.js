const path = require("node:path");
const express = require("express");

const productsRouter = require("./routes/products");
const uploadsRouter = require("./routes/uploads");
const decisionRouter = require("./routes/decision");
const preferencesRouter = require("./routes/preferences");
const { createStore } = require("./storage");

function createApp(config) {
  const app = express();
  const store = createStore(config.dataDir);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  // 健康检查
  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      ai: {
        configured: Boolean(config.llm.apiKey),
        model: config.llm.model || null,
      },
      storage: {
        productCount: store.list().length,
      },
    });
  });

  app.use("/api/products", productsRouter(store, config));
  app.use("/api/uploads", uploadsRouter(config));
  app.use("/api/decision", decisionRouter(store));
  app.use("/api/preferences", preferencesRouter(config));

  // 上传文件的静态访问（只允许已生成的随机文件名）
  app.use(
    "/uploads",
    express.static(config.uploadsDir, {
      fallthrough: false,
      dotfiles: "ignore",
      index: false,
    }),
  );

  // 原有 Demo 的静态资源（图片等）
  app.use(
    express.static(config.projectRoot, {
      index: false,
      dotfiles: "ignore",
    }),
  );

  // 首页指向当前主文件 yijian-v3.html（其中包含 Demo 与真实商品两条流程）
  app.get("/", (req, res) => {
    res.sendFile(path.join(config.projectRoot, "yijian-v3.html"));
  });

  // 未知 API 统一返回 JSON 404
  app.use("/api", (req, res) => {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "接口不存在" },
    });
  });

  // 统一错误处理：不向前端泄漏内部细节
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.expose !== undefined && err.statusCode) {
      return res.status(err.statusCode).json({
        error: { code: err.code || "REQUEST_ERROR", message: err.message || "请求无法处理" },
      });
    }
    console.error("[yijian] 未处理错误：", err && err.message ? err.message : err);
    res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "服务器出了点问题，请稍后再试" },
    });
  });

  return app;
}

module.exports = { createApp };

