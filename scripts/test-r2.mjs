import { S3Client, ListBucketsCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

process.loadEnvFile(".env.local");

const client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const bucketName = process.env.R2_BUCKET_NAME;

async function main() {
  console.log("Listing buckets...");
  const list = await client.send(new ListBucketsCommand({}));
  console.log(
    "Buckets found:",
    (list.Buckets || []).map((b) => b.Name),
  );

  const exists = (list.Buckets || []).some((b) => b.Name === bucketName);
  if (!exists) {
    console.log(`Bucket "${bucketName}" not found, creating it...`);
    await client.send(new CreateBucketCommand({ Bucket: bucketName }));
    console.log("Bucket created.");
  } else {
    console.log(`Bucket "${bucketName}" already exists.`);
  }

  console.log("Testing write...");
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: "_test/connectivity-check.json",
      Body: JSON.stringify({ ok: true, at: new Date().toISOString() }),
      ContentType: "application/json",
    }),
  );
  console.log("Write OK.");

  console.log("Testing read...");
  const obj = await client.send(
    new GetObjectCommand({ Bucket: bucketName, Key: "_test/connectivity-check.json" }),
  );
  const body = await obj.Body.transformToString();
  console.log("Read OK, contents:", body);

  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error("FAILED:", err.name, err.message);
  process.exit(1);
});
