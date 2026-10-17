import { DeleteObjectCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { createStorageClient, S3UploadStorage, uploadObjectKey } from '../src/storage/storage.js';

describe('upload object keys', () => {
  it('are random and stay under the workspace prefix', () => {
    const workspaceId = randomUUID();
    const a = uploadObjectKey(workspaceId);
    const b = uploadObjectKey(workspaceId);
    assert.notEqual(a, b);
    assert.match(a, new RegExp(`^workspaces/${workspaceId}/uploads/[0-9a-f-]{36}$`));
  });
});

const env = process.env;
const settings = {
  S3_ENDPOINT: env.S3_ENDPOINT ?? '',
  S3_REGION: env.S3_REGION ?? 'us-east-1',
  S3_FORCE_PATH_STYLE: env.S3_FORCE_PATH_STYLE === 'true',
  S3_BUCKET_UPLOADS: env.S3_BUCKET_UPLOADS ?? '',
  S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID ?? '',
  S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY ?? '',
};

async function storageSkipReason(): Promise<string | false> {
  if (settings.S3_ENDPOINT === '') return 'S3_ENDPOINT is not set';
  try {
    await createStorageClient(settings).send(
      new HeadBucketCommand({ Bucket: settings.S3_BUCKET_UPLOADS }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
    return false;
  } catch {
    return 'local storage is not running (pnpm services:up)';
  }
}

describe('uploads bucket', { skip: await storageSkipReason() }, () => {
  const urlFor = (key: string) => `${settings.S3_ENDPOINT}/${settings.S3_BUCKET_UPLOADS}/${key}`;

  it('refuses anonymous writes', async () => {
    const put = await fetch(urlFor(uploadObjectKey(randomUUID())), {
      method: 'PUT',
      body: 'a,b\n',
    });
    assert.ok(put.status === 403 || put.status === 401, `anonymous PUT gave ${put.status}`);
  });

  it('refuses anonymous reads of an object that exists', async () => {
    const client = createStorageClient(settings);
    const Key = uploadObjectKey(randomUUID());
    await client.send(
      new PutObjectCommand({ Bucket: settings.S3_BUCKET_UPLOADS, Key, Body: 'a,b\n1,2\n' }),
    );
    try {
      const get = await fetch(urlFor(Key));
      assert.ok(get.status === 403 || get.status === 401, `anonymous GET gave ${get.status}`);
    } finally {
      await client.send(new DeleteObjectCommand({ Bucket: settings.S3_BUCKET_UPLOADS, Key }));
    }
  });

  describe('signed upload URLs', () => {
    const storage = new S3UploadStorage(() => settings);
    const body = 'id,name\n1,Ada\n2,Grace\n';
    const sha256 = createHash('sha256').update(body).digest('hex');
    const keys: string[] = [];
    const newKey = () => {
      const key = uploadObjectKey(randomUUID());
      keys.push(key);
      return key;
    };
    const send = async (key: string, content: string, size = Buffer.byteLength(content)) => {
      const signed = await storage.signUpload(key, size, sha256);
      return fetch(signed.url, { method: signed.method, headers: signed.headers, body: content });
    };

    after(async () => {
      const client = createStorageClient(settings);
      for (const Key of keys) {
        await client.send(new DeleteObjectCommand({ Bucket: settings.S3_BUCKET_UPLOADS, Key }));
      }
    });

    it('accept the declared file, and stat reports its size and checksum', async () => {
      const key = newKey();
      const put = await send(key, body);
      assert.equal(put.status, 200, await put.text());
      assert.deepEqual(await storage.stat(key), { sizeBytes: Buffer.byteLength(body), sha256 });
    });

    it('refuse different content of the same size', async () => {
      const key = newKey();
      const put = await send(key, body.replace('Ada', 'Bob'));
      assert.ok(put.status >= 400, `tampered PUT gave ${put.status}`);
      assert.equal(await storage.stat(key), null);
    });

    it('refuse a bigger file than declared', async () => {
      const key = newKey();
      const signed = await storage.signUpload(key, Buffer.byteLength(body), sha256);
      const put = await fetch(signed.url, {
        method: 'PUT',
        headers: signed.headers,
        body: body + '3,Linus\n',
      }).catch(() => null);
      assert.ok(put === null || put.status >= 400, `bigger PUT gave ${put?.status}`);
      assert.equal(await storage.stat(key), null);
    });

    it('stat gives null for a missing object', async () => {
      assert.equal(await storage.stat(uploadObjectKey(randomUUID())), null);
    });
  });
});
