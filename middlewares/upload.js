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

    return cb(null, true);
  }
});

export const uploadCampaignForm = uploadCsv.any();
