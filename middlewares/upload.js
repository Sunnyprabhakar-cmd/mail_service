import multer from "multer";

const storage = multer.memoryStorage();
export const CSV_UPLOAD_MAX_BYTES = Math.max(1, Number(process.env.CSV_UPLOAD_MAX_BYTES || 50 * 1024 * 1024));

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
