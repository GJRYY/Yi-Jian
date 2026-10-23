const fs = require("node:fs");
const path = require("node:path");

// 极简 .env 加载：只处理 KEY=VALUE 行，不覆盖已有的环境变量。
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (process.env[key] === undefined && key) {
      process.env[key] = value;
    }
  }
}

function loadConfig() {
  const projectRoot = path.resolve(__dirname, "..");
  loadEnvFile(path.join(projectRoot, ".env"));

  const rawPort = Number(process.env.PORT || 3000);
  const port =
    Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 3000;

  const dataDir = path.resolve(
    projectRoot,
    process.env.DATA_DIR || path.join(projectRoot, "data"),
  );

  const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024);

  return {
    projectRoot,
    port,
    dataDir,
    uploadsDir: path.join(dataDir, "uploads"),
    maxUploadBytes: Number.isFinite(maxUploadBytes) && maxUploadBytes > 0
      ? maxUploadBytes
      : 5 * 1024 * 1024,
    llm: {
      baseUrl: String(process.env.LLM_BASE_URL || "").trim(),
      apiKey: String(process.env.LLM_API_KEY || "").trim(),
      model: String(process.env.LLM_MODEL || "").trim(),
    },
  };
}

module.exports = { loadConfig, loadEnvFile };

