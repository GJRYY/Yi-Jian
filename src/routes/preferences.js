const express = require("express");

// 第二阶段接入模型后再实现真正的偏好提取。
// 未配置模型时返回明确状态，前端据此显示「AI 服务尚未配置」。
module.exports = function preferencesRouter(config) {
  const router = express.Router();

  router.post("/extract", (req, res) => {
    if (!config.llm.apiKey) {
      return res.json({
        status: "not_configured",
        message: "AI 服务尚未配置，当前使用规则分析，不影响正常使用。",
      });
    }
    return res.json({
      status: "unavailable",
      message: "模型服务已配置，偏好提取功能将在第二阶段接入。",
    });
  });

  return router;
};

