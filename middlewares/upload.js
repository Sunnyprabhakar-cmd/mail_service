import multer from "multer";
import { mkdirSync } from "fs";
import os from "os";
import path from "path";

const uploadDir = path.join(os.tmpdir(), "backend-maily-uploads");
mkdirSync(uploadDir, { recursive: true });
export const CSV_UPLOAD_MAX_BYTES = Math.max(1, Number(process.env.CSV_UPLOAD_MAX_BYTES || 50 * 1024 * 1024));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeName = path.basename(String(file?.originalname || "upload.csv"));
    const uniquePrefix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniquePrefix}-${safeName}`);
  }
});

export const uploadCsv = multer({
  storage,
  limits: {
    fileSize: CSV_UPLOAD_MAX_BYTES
  },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === "file") {
      if (file.mimetype !== "text/csv" && !file.originalname.toLowerCase().endsWith(".csv")) {
        return cb(new Error("Only CSV files are allowed"));
      }
      return cb(null, true);
    }

    return cb(null, true);
  }
});

export const uploadCampaignForm = uploadCsv.any();
