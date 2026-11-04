import {
  S3Client,
  S3ServiceException,
  HeadBucketCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
} from "@aws-sdk/client-s3";

export type StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export class ObjectStorage {
  private readonly client: S3Client;
  constructor(private readonly config: StorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: 3,
    });
  }
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch (error) {
      if (!(error instanceof S3ServiceException) || error.$metadata.httpStatusCode !== 404)
        throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
    }
  }
  async begin(key: string, mimeType: string): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: mimeType,
      }),
    );

    if (!result.UploadId) throw new Error("Storage did not return an upload ID");

    return result.UploadId;
  }
  async part(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<string> {
    const result = await this.client.send(
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: body.byteLength,
      }),
    );

    if (!result.ETag) throw new Error("Storage did not return a part ETag");

    return result.ETag;
  }
  async complete(
    key: string,
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[],
    expectedSize: number,
  ): Promise<void> {
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
    } catch (error) {
      // A completed multipart session vanishes. Only an exact-size object at this unique server key permits replay.
      try {
        if ((await this.head(key)).size !== expectedSize) throw error;
      } catch {
        throw error;
      }
    }

    if ((await this.head(key)).size !== expectedSize)
      throw new Error("Completed object size mismatch");
  }
  async head(key: string): Promise<{ size: number }> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );

    return { size: result.ContentLength ?? 0 };
  }
  async abort(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (!(error instanceof S3ServiceException) || error.name !== "NoSuchUpload") throw error;
    }
  }
  async abortUnfinished(key: string, retainedUploadId?: string): Promise<void> {
    // Prefix narrows the page; equality prevents touching neighbouring object keys.
    // Repeated cleanup sweeps drain further pages and catch late create responses.
    const page = await this.client.send(
      new ListMultipartUploadsCommand({
        Bucket: this.config.bucket,
        Prefix: key,
        MaxUploads: 100,
      }),
    );

    for (const upload of page.Uploads ?? [])
      if (upload.Key === key && upload.UploadId && upload.UploadId !== retainedUploadId)
        await this.abort(key, upload.UploadId);
  }
  async read(
    key: string,
    range?: string,
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number; contentRange?: string }> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key, Range: range }),
    );

    if (!result.Body) throw new Error("Empty storage response");

    return {
      body: result.Body.transformToWebStream().pipeThrough(
        new TransformStream<unknown, Uint8Array>({
          transform(chunk, controller) {
            if (!(chunk instanceof Uint8Array))
              throw new Error("Storage returned a non-byte stream chunk");
            controller.enqueue(chunk);
          },
        }),
      ),
      size: result.ContentLength ?? 0,
      contentRange: result.ContentRange,
    };
  }
  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
  async purgeOwner(ownerId: string): Promise<{ deleted: number; pending: boolean }> {
    const prefix = `owners/${ownerId}/`;

    const uploads = await this.client.send(
      new ListMultipartUploadsCommand({
        Bucket: this.config.bucket,
        Prefix: prefix,
        MaxUploads: 100,
      }),
    );

    for (const upload of uploads.Uploads ?? [])
      if (upload.Key && upload.UploadId) await this.abort(upload.Key, upload.UploadId);

    const page = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, MaxKeys: 100 }),
    );

    for (const object of page.Contents ?? []) if (object.Key) await this.remove(object.Key);

    return {
      deleted: page.Contents?.length ?? 0,
      pending: Boolean(page.IsTruncated || uploads.IsTruncated),
    };
  }
  close(): void {
    this.client.destroy();
  }
}
