/**
 * Pluggable object storage for token-metadata uploads.
 *
 * The launchpad lets a market creator attach a logo + name + symbol to the
 * token they are listing. Those bytes have to live somewhere the browser can
 * fetch them back by URL. This module defines a tiny {@link StorageDriver}
 * interface and a {@link createStorage} factory that picks a concrete driver
 * from the `TOKEN_STORAGE_DRIVER` environment variable, so the app ships
 * working out of the box (local disk) and is swappable for production
 * (S3 / Cloudflare R2) without touching the route that consumes it.
 *
 * Only `src/app/api/metadata/route.ts` imports this. It is server-only: the
 * drivers read secrets from the environment and write to the filesystem or an
 * S3-compatible endpoint, neither of which can run in the browser bundle.
 *
 * Honesty: a driver either returns a real, fetchable URI or throws. There is no
 * stub that pretends to store bytes. The local driver writes a real file under
 * `public/uploads`; the S3 driver performs a real, SigV4-signed `PUT` against
 * the configured bucket. If a required env var is missing, the factory throws
 * at construction with a message naming the missing variable rather than
 * silently degrading to a no-op.
 */

import { createHash, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The result of persisting one object: the public, fetchable URL the uploaded
 * bytes are reachable at. For the local driver this is a same-origin
 * `/uploads/<key>` path; for S3/R2 it is the object's public URL (built from
 * `STORAGE_PUBLIC_BASE_URL` or the bucket/endpoint).
 */
export interface PutResult {
  /** Public URL the stored object can be fetched from. */
  uri: string;
}

/**
 * A storage backend: the single operation the upload route needs is to write a
 * blob at a caller-chosen `key` and get back its public URL. Implementations
 * are responsible for making the object publicly readable at the returned URI.
 */
export interface StorageDriver {
  /** Stable identifier of the concrete backend, for logging/diagnostics. */
  readonly name: string;
  /**
   * Persist `bytes` under `key` with the given `contentType` and return the
   * object's public URI. `key` is a relative path (no leading slash), already
   * namespaced and sanitized by the caller, e.g. `tokens/<hash>.png`.
   */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<PutResult>;
}

/**
 * Read a required environment variable or throw a clear error. Used by the
 * driver factories so a misconfigured production deploy fails fast at the first
 * upload with a message naming the missing variable, instead of producing a
 * broken URL.
 */
function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    throw new Error(
      `storage: ${key} is required when TOKEN_STORAGE_DRIVER selects this backend`,
    );
  }
  return v;
}

/**
 * The clone-and-run default driver: write uploaded bytes to the app's
 * `public/uploads` directory and serve them same-origin at `/uploads/<key>`.
 *
 * Next serves everything under `public/` statically, so a file written here is
 * immediately fetchable at the returned URI with no CDN, bucket, or external
 * account. This is a REAL implementation, not a placeholder: the bytes hit the
 * disk and the URL resolves. It is the right default for local development and
 * single-node self-hosting; switch to S3/R2 for multi-node or durable storage.
 */
export class LocalFsDriver implements StorageDriver {
  readonly name = "local";

  /** Absolute path to the `public` directory uploads are written under. */
  private readonly publicDir: string;

  /**
   * @param publicDir Absolute path to the Next `public/` directory. Defaults to
   * `<cwd>/public`, which is correct when the app runs from its own package
   * root (the `dev`/`start` scripts do).
   */
  constructor(publicDir: string = path.join(process.cwd(), "public")) {
    this.publicDir = publicDir;
  }

  async put(
    key: string,
    bytes: Uint8Array,
    _contentType: string,
  ): Promise<PutResult> {
    // Resolve the destination under public/uploads and refuse any key that
    // escapes that directory (defense in depth; the route already sanitizes).
    const uploadsRoot = path.join(this.publicDir, "uploads");
    const dest = path.join(uploadsRoot, key);
    const normalizedRoot = path.resolve(uploadsRoot);
    if (!path.resolve(dest).startsWith(normalizedRoot + path.sep)) {
      throw new Error("storage: refusing to write outside the uploads directory");
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
    // Same-origin URL; the leading slash makes it root-relative so it resolves
    // under whatever host the app is served from.
    return { uri: `/uploads/${key}` };
  }
}

/** SHA-256 hex digest, used by the SigV4 signing process below. */
function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** HMAC-SHA256 returning a raw Buffer, the building block of the SigV4 key. */
function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * An S3-compatible driver (AWS S3, Cloudflare R2, Backblaze B2, MinIO, ...),
 * enabled by `TOKEN_STORAGE_DRIVER=s3`.
 *
 * This is a REAL adapter, not a stub. It performs a genuine
 * `PUT <endpoint>/<bucket>/<key>` over `fetch`, signed with AWS Signature
 * Version 4 computed here with Node's built-in crypto, so it needs NO
 * `aws-sdk` dependency (the scaffold stays dependency-light and the bundle
 * small). The same signing works against any S3-compatible endpoint, which is
 * why R2 (the recommended cheap option) works unchanged - just point
 * `STORAGE_S3_ENDPOINT` at the R2 account endpoint.
 *
 * Required env (validated lazily at construction):
 *   STORAGE_S3_BUCKET            bucket name
 *   STORAGE_S3_REGION            region (use "auto" for R2)
 *   STORAGE_S3_ACCESS_KEY_ID     access key id
 *   STORAGE_S3_SECRET_ACCESS_KEY secret access key
 * Optional:
 *   STORAGE_S3_ENDPOINT          S3-compatible endpoint; defaults to AWS
 *                                `https://s3.<region>.amazonaws.com`. Set this
 *                                for R2/B2/MinIO.
 *   STORAGE_PUBLIC_BASE_URL      public base URL objects are served from (a CDN
 *                                or the bucket's public URL). When unset the
 *                                returned URI is the signed endpoint path,
 *                                which is correct for public-read buckets.
 *
 * The object is written with `x-amz-acl: public-read` so the returned URL is
 * immediately fetchable on buckets that honor object ACLs. On R2 (which ignores
 * ACLs) make the bucket/public-bucket access public and set
 * STORAGE_PUBLIC_BASE_URL to the public dev/custom domain.
 */
export class S3Driver implements StorageDriver {
  readonly name = "s3";

  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  /** Endpoint origin without a trailing slash, e.g. `https://s3.us-east-1.amazonaws.com`. */
  private readonly endpoint: string;
  /** Optional public base URL (CDN) without a trailing slash. */
  private readonly publicBaseUrl: string | null;

  constructor() {
    this.bucket = requireEnv("STORAGE_S3_BUCKET");
    this.region = requireEnv("STORAGE_S3_REGION");
    this.accessKeyId = requireEnv("STORAGE_S3_ACCESS_KEY_ID");
    this.secretAccessKey = requireEnv("STORAGE_S3_SECRET_ACCESS_KEY");
    const endpoint =
      process.env.STORAGE_S3_ENDPOINT?.replace(/\/+$/, "") ||
      `https://s3.${this.region}.amazonaws.com`;
    this.endpoint = endpoint;
    const base = process.env.STORAGE_PUBLIC_BASE_URL?.replace(/\/+$/, "");
    this.publicBaseUrl = base && base.length > 0 ? base : null;
  }

  async put(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<PutResult> {
    // Path-style addressing (`<endpoint>/<bucket>/<key>`) works on every
    // S3-compatible provider, including R2 and MinIO, without DNS for virtual
    // hosting. Each path segment is URL-encoded but slashes are preserved so a
    // key like `tokens/abc.png` stays a real key path.
    const url = new URL(this.endpoint);
    const host = url.host;
    const encodedKey = key
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    const canonicalUri = `/${this.bucket}/${encodedKey}`;
    const target = `${this.endpoint}${canonicalUri}`;

    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, "")
      .replace(/(\d{8})T(\d{6})Z/, "$1T$2Z");
    const dateStamp = amzDate.slice(0, 8);

    const payloadHash = sha256Hex(bytes);
    const service = "s3";
    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;

    // Headers that participate in the signature, sorted by lowercased name.
    const signedHeaderMap: Record<string, string> = {
      "content-type": contentType,
      host,
      "x-amz-acl": "public-read",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const sortedHeaderNames = Object.keys(signedHeaderMap).sort();
    const canonicalHeaders =
      sortedHeaderNames.map((h) => `${h}:${signedHeaderMap[h]}\n`).join("");
    const signedHeaders = sortedHeaderNames.join(";");

    const canonicalRequest = [
      "PUT",
      canonicalUri,
      "", // no query string
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");

    // Derive the SigV4 signing key and sign.
    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning)
      .update(stringToSign, "utf8")
      .digest("hex");

    const authorization =
      `${algorithm} Credential=${this.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(target, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "x-amz-acl": "public-read",
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        Authorization: authorization,
      },
      // web3/Next fetch accepts a Uint8Array body directly.
      body: bytes,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `storage: S3 PUT failed (${res.status} ${res.statusText})${detail ? ` - ${detail.slice(0, 300)}` : ""}`,
      );
    }

    // Prefer the configured public base URL (CDN/custom domain); otherwise the
    // signed endpoint path is the canonical object URL for a public-read bucket.
    const uri = this.publicBaseUrl
      ? `${this.publicBaseUrl}/${encodedKey}`
      : target;
    return { uri };
  }
}

/**
 * The set of recognized driver identifiers. An unknown value is intentionally
 * NOT a silent fallback: it throws so a typo in `TOKEN_STORAGE_DRIVER` surfaces
 * immediately rather than silently using local disk in production.
 */
export type StorageDriverName = "local" | "s3";

/**
 * Select and construct the storage driver from the environment.
 *
 * `TOKEN_STORAGE_DRIVER` chooses the backend; it defaults to `local` so a fresh
 * clone runs with zero configuration (logos land in `public/uploads`). Set it to
 * `s3` and supply the `STORAGE_S3_*` vars for production. The factory is cheap
 * to call per-request (the drivers are stateless apart from cached config), so
 * the upload route constructs one on demand and does not need a singleton.
 *
 * Throws for an unrecognized driver name so a misconfiguration is loud.
 */
export function createStorage(): StorageDriver {
  const driver = (process.env.TOKEN_STORAGE_DRIVER ?? "local").toLowerCase();
  switch (driver) {
    case "":
    case "local":
      return new LocalFsDriver();
    case "s3":
      return new S3Driver();
    default:
      throw new Error(
        `storage: unknown TOKEN_STORAGE_DRIVER "${driver}" (expected "local" or "s3")`,
      );
  }
}
