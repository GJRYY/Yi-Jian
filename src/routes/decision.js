const express = require("express");

const { decide } = require("../rules/engine");
const { toEngineProduct } = require("../rules/derive");

module.exports = function decisionRouter(store) {
  const router = express.Router();

  router.post("/analyze", (req, res) => {
    const productIds = req.body?.productIds;
    const answers = req.body?.answers || {};

    if (!Array.isArray(productIds) || productIds.length < 1) {
      return res.status(400).json({
        error: { code: "NO_PRODUCTS", message: "请至少选择一件商品再分析" },
      });
    }
    if (productIds.length > 4) {
      return res.status(400).json({
        error: { code: "TOO_MANY_PRODUCTS", message: "一次最多分析 4 件商品" },
      });
    }

    const records = productIds.map((id) => store.get(String(id)));
    const missing = productIds.filter((id, index) => !records[index]);
    if (missing.length) {
      return res.status(404).json({
        error: {
          code: "PRODUCT_NOT_FOUND",
          message: "部分商品已不存在，请刷新商品列表",
          productIds: missing,
        },
      });
    }

    const unconfirmed = records.filter((record) => !record.confirmed);
    if (unconfirmed.length) {
      return res.status(422).json({
        error: {
          code: "UNCONFIRMED_PRODUCTS",
          message: "还有商品资料没有确认，请先确认后再分析",
          productIds: unconfirmed.map((record) => record.id),
        },
      });
    }

    const products = records.map(toEngineProduct);
    const result = decide(products, answers);
    res.json(result);
  });

  return router;
};

