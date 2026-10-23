const fs = require("node:fs");
const path = require("node:path");

const PRODUCTS_FILE = "products.json";

function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  const filePath = path.join(dataDir, PRODUCTS_FILE);

  function read() {
    if (!fs.existsSync(filePath)) {
      return { version: 1, products: [] };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!parsed || !Array.isArray(parsed.products)) {
        throw new Error("bad shape");
      }
      return parsed;
    } catch {
      // 数据文件损坏时保留原文件，避免直接覆盖用户数据
      const brokenPath = `${filePath}.broken-${Date.now()}`;
      fs.renameSync(filePath, brokenPath);
      console.error(`[yijian] 商品数据文件损坏，已备份到 ${brokenPath}，重新开始。`);
      return { version: 1, products: [] };
    }
  }

  function write(data) {
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  }

  function list() {
    return read().products;
  }

  function get(id) {
    return list().find((product) => product.id === id) || null;
  }

  function save(record) {
    const data = read();
    const index = data.products.findIndex((product) => product.id === record.id);
    if (index >= 0) data.products[index] = record;
    else data.products.push(record);
    write(data);
    return record;
  }

  function remove(id) {
    const data = read();
    const removed = data.products.find((product) => product.id === id) || null;
    data.products = data.products.filter((product) => product.id !== id);
    write(data);
    return removed;
  }

  return {
    list,
    get,
    save,
    remove,
    dataDir,
    uploadsDir: path.join(dataDir, "uploads"),
    productsFilePath: filePath,
  };
}

module.exports = { createStore };

