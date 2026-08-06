import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function getR2Config() {
  const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID;
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    throw new Error('Cloudflare R2 server configuration is incomplete.');
  }

  return {
    bucketName,
    client: new S3Client({
      region: 'auto',
      endpoint:
        process.env.CLOUDFLARE_R2_ENDPOINT ||
        `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    }),
  };
}

/**
 * Generate a presigned upload URL for direct client-to-R2 upload.
 *
 * Deliberately does not set ChecksumSHA256. The SDK encodes it as a signed
 * *query parameter* (SignedHeaders stays `host`), so a client that also sends
 * the matching `x-amz-checksum-sha256` header invalidates the signature and R2
 * answers 403. R2 discards the value either way: uploading a body that does not
 * match the declared checksum still returns 200, and a subsequent HEAD reports
 * no ChecksumSHA256 at all. It bought no integrity and only broke uploads.
 * Size and content type are verified server-side in /api/upload/finalize via
 * headR2Object instead.
 */
export async function getR2UploadPresignedUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 900,
): Promise<string> {
  const { client, bucketName } = getR2Config();
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType,
  });

  return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

export async function headR2Object(key: string) {
  const { client, bucketName } = getR2Config();
  const response = await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
  return {
    contentLength: response.ContentLength,
    contentType: response.ContentType,
    checksumSha256: response.ChecksumSHA256,
    etag: response.ETag,
  };
}

export async function deleteR2Object(key: string) {
  const { client, bucketName } = getR2Config();
  await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}

/**
 * Writes a small object directly. Documents are uploaded straight to R2 with a
 * presigned URL, but a profile photo is already on the server by the time it is
 * validated, so a second round trip through the browser would gain nothing.
 */
export async function putR2Object(key: string, body: Uint8Array, contentType: string) {
  const { client, bucketName } = getR2Config();
  await client.send(
    new PutObjectCommand({ Bucket: bucketName, Key: key, Body: body, ContentType: contentType }),
  );
}

/**
 * Returns a plain Uint8Array, never a Node Buffer.
 *
 * pdf.js clones the input through `new value.constructor(value)`. For a Buffer
 * that is the deprecated `new Buffer(...)`, which allocates from Node's shared
 * pool, so `byteOffset` becomes non-zero. pdf.js then calls `makeSubStream`
 * using `bytes.buffer` and resolves every object offset against the whole pool,
 * failing with "bad XRef entry". A plain Uint8Array clones to offset 0.
 */
export async function getR2ObjectBytes(key: string, maximumBytes: number): Promise<Uint8Array> {
  const metadata = await headR2Object(key);
  if (!metadata.contentLength || metadata.contentLength > maximumBytes) {
    throw new Error('R2_OBJECT_SIZE_UNSUPPORTED');
  }

  const { client, bucketName } = getR2Config();
  const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  if (!response.Body) throw new Error('R2_OBJECT_BODY_MISSING');

  const bytes = await response.Body.transformToByteArray();
  if (bytes.byteLength > maximumBytes) throw new Error('R2_OBJECT_SIZE_UNSUPPORTED');

  // Copy into a dedicated ArrayBuffer at offset 0, as a plain Uint8Array.
  const dedicated = new Uint8Array(bytes.byteLength);
  dedicated.set(bytes);
  return dedicated;
}

/**
 * Generate a presigned download URL for registered users
 */
export async function getR2DownloadPresignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
  const { client, bucketName } = getR2Config();
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}
