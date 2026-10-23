const { createApp } = require("./src/app");
const { loadConfig } = require("./src/config");

const config = loadConfig();
const app = createApp(config);

app.listen(config.port, () => {
  console.log(`[yijian] 衣见后端已启动：http://localhost:${config.port}`);
  console.log(`[yijian] 数据目录：${config.dataDir}`);
  if (!config.llm.apiKey) {
    console.log(
      "[yijian] 未配置模型服务（LLM_API_KEY 为空），当前使用规则分析，AI 能力将在第二阶段启用。",
    );
  } else {
    console.log(
      `[yijian] 已检测到模型配置（${config.llm.model}），模型调用将在第二阶段接入。`,
    );
  }
});

