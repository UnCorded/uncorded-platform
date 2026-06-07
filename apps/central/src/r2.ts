import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

export interface PresignedPost {
  readonly url: string;
  readonly fields: Record<string, string>;
}

export interface R2Client {
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  presignedGetUrl(key: string, expiresIn: number): Promise<string>;
  /**
   * Generate a presigned POST that R2 will reject if the request body is
   * larger than `maxBytes`. This is the only way to bound upload size from
   * the server side: a presigned PUT signs the URL but not the body length,
   * so once the URL is issued the holder can stream arbitrary bytes into
   * the bucket. Presigned POST embeds a policy document that R2 enforces
   * on every part of the upload before storing.
   */
  presignedPost(
    key: string,
    contentType: string,
    maxBytes: number,
    expiresIn: number,
  ): Promise<PresignedPost>;
  publicUrl(key: string): string;
}

export function createR2Client(): R2Client | null {
  const accountId = process.env["R2_ACCOUNT_ID"];
  const accessKeyId = process.env["R2_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["R2_SECRET_ACCESS_KEY"];
  const bucket = process.env["R2_BUCKET_NAME"];

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    async putObject(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },

    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    async presignedGetUrl(key, expiresIn) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn },
      );
    },

    async presignedPost(key, contentType, maxBytes, expiresIn) {
      const { url, fields } = await createPresignedPost(client, {
        Bucket: bucket,
        Key: key,
        Conditions: [
          ["content-length-range", 0, maxBytes],
          ["eq", "$Content-Type", contentType],
        ],
        Fields: { "Content-Type": contentType },
        Expires: expiresIn,
      });
      return { url, fields };
    },

    publicUrl(key) {
      const base =
        process.env["R2_PUBLIC_URL"] ??
        `https://${bucket}.${accountId}.r2.cloudflarestorage.com`;
      return `${base}/${key}`;
    },
  };
}
