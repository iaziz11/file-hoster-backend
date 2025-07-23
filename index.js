import express from "express";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import admin from "firebase-admin";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import cors from "cors";
import fs from "fs";
import archiver from "archiver";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
dotenv.config();

const serviceAccount = JSON.parse(
  fs.readFileSync(process.env.FIREBASE_KEY_PATH, "utf-8")
);
const s3 = new S3Client({
  region: process.env.AWS_REGION,
});

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.use(express.json());

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:80",
  "https://d2oci8gd63g7dj.cloudfront.net/",
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
};
// app.use(cors(corsOptions));
app.use(cors());

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: No token provided" });
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized: Invalid token" });
  }
};

const getS3ReadStream = async (Bucket, Key) => {
  const fullKey = "uploads/" + Key;
  const command = new GetObjectCommand({ Bucket, Key: fullKey });
  const response = await s3.send(command);
  return response.Body;
};

app.post("/upload", authenticate, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded.");

  const params = {
    Bucket: "mpower-app-files",
    Key: "uploads/" + req.body.fileId,
    Body: req.file.buffer,
    ContentType: req.file.mimetype,
  };

  try {
    await s3.send(new PutObjectCommand(params));
    res.status(200).send("File uploaded successfully!");
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).send("Failed to upload file.");
  }
});

app.post("/download/folder", authenticate, async (req, res) => {
  if (!req.body?.files) res.status(400).send("No files specified");
  const fileList = req.body.files;
  const folderName = req.body.folderName;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${folderName}.zip`
  );
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(res);

  for (const fileTuple of fileList) {
    const s3Stream = await getS3ReadStream("mpower-app-files", fileTuple[0]);
    archive.append(s3Stream, { name: fileTuple[1] });
  }
  archive.finalize();
});

app.get("/download/:fileKey", authenticate, async (req, res) => {
  const { fileKey } = req.params;

  const command = new GetObjectCommand({
    Bucket: "mpower-app-files",
    Key: "uploads/" + fileKey,
  });

  try {
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });
    res.json({ url: signedUrl });
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).send("Failed to generate download link.");
  }
});

app.get("/document/:fileKey", async (req, res) => {
  const { fileKey } = req.params;
  const command = new GetObjectCommand({
    Bucket: "mpower-app-files",
    Key: "uploads/" + fileKey,
  });

  try {
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 120 });
    res.json({ url: signedUrl });
  } catch (err) {
    console.error("Url error:", err);
    res.status(500).send("Failed to generate presigned url.");
  }
});

app.post("/document/:fileKey", async (req, res) => {
  const payload = req.body;
  console.log(payload);
  const fileUrl = payload?.url;
  const { fileKey } = req.params;
  if (req.body.status === 6 || req.body.status === 2) {
    try {
      const response = await fetch(fileUrl);
      if (!response.ok)
        throw new Error(`Failed to download file: ${response.statusText}`);

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const getCommand = new GetObjectCommand({
        Bucket: "mpower-app-files",
        Key: "uploads/" + fileKey,
      });
      const getResponse = await s3.send(getCommand);
      const fileType = getResponse.ContentType;

      // Upload to S3
      const putCommand = new PutObjectCommand({
        Bucket: "mpower-app-files",
        Key: "uploads/" + fileKey,
        Body: buffer,
        ContentType: fileType,
      });

      await s3.send(putCommand);

      console.log(`File saved successfully`);

      return res.status(200).json({ error: 0 });
    } catch (error) {
      console.error("Error saving file to S3:", error);
      return res.status(500).json({ error: 1, message: error.message });
    }
  }

  res.status(200).json({ error: 0 });
});

app.delete("/delete/:fileKey", authenticate, async (req, res) => {
  const { fileKey } = req.params;
  const params = {
    Bucket: "mpower-app-files",
    Key: "uploads/" + fileKey,
  };

  try {
    const command = new DeleteObjectCommand(params);
    const response = await s3.send(command);
    res.status(200).send("File deleted successfully, ", response);
  } catch (e) {
    console.log(e.message);
    res.status(500).send("Delete failed: ", e);
  }
});

app.delete("/deleteUser/:userId", authenticate, async (req, res) => {
  const { userId } = req.params;
  if (!userId) res.status(400).send("No user specified");
  try {
    admin.auth().deleteUser(userId);
    res.status(200).send("User successfully deleted");
  } catch (e) {
    res.status(500).send("Could not delete user");
    console.log(e.message);
  }
});

app.listen(3000, () => console.log("Listening on 3000"));
