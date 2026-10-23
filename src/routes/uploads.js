const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

// 通过文件头（魔数）校验，不信任客户端声明的 MIME 类型
function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

module.exports = function uploadsRouter(config) {
  const router = express.Router();
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.uploadsDir),
    filename: (req, file, cb) => {
      const ext = (() => {
        if (file.mimetype === "image/png") return ".png";
        if (file.mimetype === "image/webp") return ".webp";
        return ".jpg";
      })();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
    },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_MIME.has(file.mimetype)) {
        const error = new Error("只支持 JPG、PNG 或 WebP 格式的图片");
        error.code = "UNSUPPORTED_TYPE";
        return cb(error);
      }
      cb(null, true);
    },
  });

  router.post("/", (req, res) => {
    upload.single("image")(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            error: {
              code: "FILE_TOO_LARGE",
              message: `图片超过大小限制（${Math.round(config.maxUploadBytes / 1024 / 1024)}MB）`,
            },
          });
        }
        return res.status(400).json({
          error: {
            code: err.code || "UPLOAD_FAILED",
            message: err.message || "上传失败，请重试",
          },
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: { code: "NO_FILE", message: "没有收到图片文件" },
        });
      }

      // 二次校验文件内容，防止伪装成图片的其他文件
      const buffer = fs.readFileSync(req.file.path);
      const sniffed = sniffImage(buffer);
      if (!sniffed || !ALLOWED_MIME.has(sniffed)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          // 忽略清理失败
        }
        return res.status(400).json({
          error: {
            code: "INVALID_IMAGE_CONTENT",
            message: "文件内容不是有效的图片，已拒绝",
          },
        });
      }

      const fileName = path.basename(req.file.filename);
      res.status(201).json({
        url: `/uploads/${fileName}`,
        name: req.file.originalname,
        size: req.file.size,
        mime: sniffed,
      });
    });
  });

  return router;
};

