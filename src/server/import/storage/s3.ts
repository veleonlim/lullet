import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { assertStorageKey, type ImageStorage, type StoredImage } from "./types";

export interface S3Config {
  /** For Cloudflare R2: https://<account id>.r2.cloudflarestorage.com */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** The one method of the AWS client this adapter uses, so tests can stand in for the network. */
export interface S3Sender {
  send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand): Promise<unknown>;
}

interface GetResult {
  Body?: { transformToByteArray(): Promise<Uint8Array> };
  ContentType?: string;
}

/**
 * Cloudflare R2 (or any S3 compatible private bucket). The bucket stays private: objects are only
 * ever read through this adapter with the app's own credentials.
 */
export class S3Storage implements ImageStorage {
  constructor(
    private readonly config: S3Config,
    private readonly client: S3Sender = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // R2 does not support virtual hosted style bucket addressing on every endpoint.
      forcePathStyle: true,
    }),
  ) {}

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertStorageKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        CacheControl: "private, no-store",
      }),
    );
  }

  async get(key: string): Promise<StoredImage | null> {
    assertStorageKey(key);
    try {
      const result = (await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      )) as GetResult;
      if (!result.Body) return null;
      return {
        bytes: await result.Body.transformToByteArray(),
        contentType: result.ContentType ?? "application/octet-stream",
      };
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        (error.name === "NoSuchKey" || error.$metadata.httpStatusCode === 404)
      ) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    // S3 and R2 answer success whether or not the key existed.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}
