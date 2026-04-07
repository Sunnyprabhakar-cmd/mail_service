import multer from "multer";

const storage = multer.memoryStorage();

export const uploadCsv = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === "file") {
      if (file.mimetype !== "text/csv" && !file.originalname.toLowerCase().endsWith(".csv")) {
        return cb(new Error("Only CSV files are allowed"));
      }
      return cb(null, true);
    }

    if (file.fieldname === "assetFiles") {
      if (!String(file.mimetype || "").startsWith("image/")) {
        return cb(new Error("Only image files are allowed for assetFiles"));
      }
      return cb(null, true);
    }

    return cb(new Error(`Unexpected file field: ${file.fieldname}`));
  }
});

export const uploadCampaignForm = uploadCsv.fields([
  { name: "file", maxCount: 1 },
  { name: "assetFiles", maxCount: 40 }
]);
