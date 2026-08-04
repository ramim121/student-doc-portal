/**
 * End-to-end Cloudflare R2 smoke test - the checklist in setup.md section 6,
 * executed against the credentials in .env.
 *
 *   node scripts/verify-r2.mjs
 *
 * Exercises exactly the path the upload feature uses:
 *   presign PUT -> upload over that URL -> HEAD -> presign GET -> download ->
 *   byte compare -> delete.
 *
 * The temporary object lives under studydock-verify/ and is always removed.
 */
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadEnv, reportEnv } from './_env.mjs';

loadEnv();

const REQUIRED = [
  'CLOUDFLARE_R2_ACCOUNT_ID',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_BUCKET_NAME',
];

console.log('R2 configuration:');
reportEnv([...REQUIRED, 'CLOUDFLARE_R2_ENDPOINT']);

const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
if (missing.length) {
  console.error(`\nCannot run: ${missing.join(', ')} not set in Student-doc-portal/.env`);
  process.exit(1);
}

const bucket = process.env.CLOUDFLARE_R2_BUCKET_NAME.trim();
const endpoint =
  process.env.CLOUDFLARE_R2_ENDPOINT?.trim() ||
  `https://${process.env.CLOUDFLARE_R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`;

const s3 = new S3Client({
  region: 'auto',
  endpoint,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID.trim(),
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY.trim(),
  },
});

const key = `studydock-verify/${randomUUID()}.txt`;
const payload = Buffer.from(`STUDYDOCK R2 verification ${randomUUID()}`, 'utf8');
const results = [];
let uploaded = false;

const record = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};

console.log(`\nBucket   ${bucket}`);
console.log(`Endpoint ${endpoint}`);
console.log(`Key      ${key}\n`);

try {
  const putUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'text/plain' }),
    { expiresIn: 900 },
  );
  record('presign PUT', putUrl.startsWith('https://'), `${putUrl.slice(0, 60)}...`);

  const putResponse = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: payload,
  });
  uploaded = putResponse.ok;
  record('upload via presigned PUT', putResponse.ok, `HTTP ${putResponse.status}`);
  if (!putResponse.ok) {
    console.error(`\n${(await putResponse.text()).slice(0, 600)}`);
    throw new Error('Upload rejected. Check the S3 credential permissions and bucket name.');
  }

  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  record(
    'HEAD object',
    head.ContentLength === payload.byteLength,
    `${head.ContentLength} bytes, ${head.ContentType}`,
  );

  const getUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 900 },
  );
  record('presign GET', getUrl.startsWith('https://'));

  const getResponse = await fetch(getUrl);
  const downloaded = Buffer.from(await getResponse.arrayBuffer());
  record(
    'download and byte compare',
    getResponse.ok && downloaded.equals(payload),
    `HTTP ${getResponse.status}, ${downloaded.byteLength} bytes`,
  );
} catch (error) {
  record('r2 round trip', false, error.message);
  if (/Unauthorized|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(error.message || '')) {
    console.error('\nThe S3 Access Key ID / Secret pair looks wrong.');
    console.error('Use an R2 "Object Read & Write" token, not a Cloudflare API token.');
  }
  if (/NoSuchBucket/i.test(error.message || '')) {
    console.error(`\nBucket "${bucket}" does not exist in this account.`);
  }
} finally {
  if (uploaded) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      record('delete object (cleanup)', true);
    } catch (error) {
      record('delete object (cleanup)', false, error.message);
      console.error(`\nLeftover object to remove manually: ${key}`);
    }
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);

console.log(`
Server-side R2 access works.

Browser uploads additionally need CORS on the bucket. In the Cloudflare
dashboard set the bucket CORS policy to:

[
  {
    "AllowedOrigins": ["http://localhost:3000"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type", "Content-Length", "x-amz-checksum-sha256"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]

Add the production origin alongside localhost before deploying.
`);
