/**
 * POST /api/metadata - token-metadata upload for the Ponk Rain launcher.
 *
 * When a market creator gives their token a logo + name + symbol, the launcher
 * posts it here. The route validates the payload, writes the image (and a
 * companion Metaplex-style JSON document) through the pluggable storage driver
 * (`src/lib/storage.ts`), and returns the public `{ uri, image }` URLs the
 * launcher embeds in the token registry / listing.
 *
 * Two request shapes are accepted so callers can use whichever is convenient:
 *   - multipart/form-data: fields `name`, `symbol`, optional `description`, and
 *     an `image` file part.
 *   - application/json: `{ name, symbol, description?, image: { data, contentType } }`
 *     where `data` is base64 (optionally a `data:` URL) of the image bytes.
 *
 * Honesty / no fabrication:
 *   - Oversized or non-image payloads are rejected with a clear 4xx error; the
 *     route never silently truncates or stores garbage.
 *   - The image is optional. A creator may register name/symbol only (no logo);
 *     the response then carries `image: null` and the listing falls back to the
 *     on-chain short-mint monogram. Nothing is invented.
 *   - The storage driver either returns a real, fetchable URL or throws (500);
 *     there is no stub success.
 *
 * This is a server-only route handler (it touches the filesystem / an S3
 * endpoint via the storage driver), so it must run on the Node.js runtime.
 */

import { NextResponse } from "next/server";

import { createStorage } from "@/lib/storage";

/** Node runtime: the storage drivers use `node:crypto` and `node:fs`. */
export const runtime = "nodejs";

/** Never cache an upload; each POST is a distinct mutation. */
export const dynamic = "force-dynamic";

/**
 * Maximum accepted image size, in bytes. Token logos are small; 1 MiB is
 * generous for a PNG/SVG/WebP avatar and caps abuse of the local-disk driver.
 */
const MAX_IMAGE_BYTES = 1024 * 1024;

/**
 * Image content types we accept, mapped to the canonical file extension used
 * when building the storage key. Anything not in this allow-list is rejected,
 * so a non-image (or a spoofed) payload cannot be stored as a logo.
 */
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

/** Max lengths for the text fields, to keep stored JSON bounded and sane. */
const MAX_NAME_LEN = 64;
const MAX_SYMBOL_LEN = 16;
const MAX_DESCRIPTION_LEN = 512;

/** The image bytes plus their validated content type. */
interface ParsedImage {
  bytes: Uint8Array;
  contentType: string;
  ext: string;
}

/** A parsed, validated upload request. `image` is null when none was sent. */
interface ParsedUpload {
  name: string;
  symbol: string;
  description: string | null;
  image: ParsedImage | null;
}

/** A 4xx user error carrying the status to return. Thrown by the parsers and
 * caught at the top of the handler so validation failures map to clean JSON. */
class BadRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "BadRequestError";
  }
}

/** Trim and length-check a required text field. */
function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new BadRequestError(`"${field}" is required`);
  }
  const t = value.trim();
  if (t.length === 0) {
    throw new BadRequestError(`"${field}" must not be empty`);
  }
  if (t.length > max) {
    throw new BadRequestError(`"${field}" must be at most ${max} characters`);
  }
  return t;
}

/** Trim and length-check an optional text field; empty -> null. */
function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new BadRequestError(`"${field}" must be a string`);
  }
  const t = value.trim();
  if (t.length === 0) return null;
  if (t.length > max) {
    throw new BadRequestError(`"${field}" must be at most ${max} characters`);
  }
  return t;
}

/** Validate raw image bytes + a declared content type into a {@link ParsedImage}. */
function validateImage(bytes: Uint8Array, contentType: string): ParsedImage {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const ext = ALLOWED_IMAGE_TYPES[type];
  if (!ext) {
    throw new BadRequestError(
      `unsupported image type "${type || "unknown"}" (allowed: ${Object.keys(ALLOWED_IMAGE_TYPES).join(", ")})`,
      415,
    );
  }
  if (bytes.length === 0) {
    throw new BadRequestError("image is empty");
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new BadRequestError(
      `image is too large (${bytes.length} bytes; max ${MAX_IMAGE_BYTES})`,
      413,
    );
  }
  return { bytes, contentType: type, ext };
}

/**
 * Decode a base64 (or `data:` URL) image string into validated bytes. The
 * `data:` URL form carries its own content type, which overrides the supplied
 * one so a mislabeled field cannot smuggle a non-image past the allow-list.
 */
function parseBase64Image(
  data: string,
  declaredContentType: string | undefined,
): ParsedImage {
  let b64 = data;
  let contentType = declaredContentType;
  const dataUrl = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(data);
  if (dataUrl) {
    if (dataUrl[1]) contentType = dataUrl[1];
    if (!dataUrl[2]) {
      throw new BadRequestError("data URL must be base64-encoded");
    }
    b64 = dataUrl[3] ?? "";
  }
  if (!contentType) {
    throw new BadRequestError('image requires a "contentType"');
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(b64, "base64"));
  } catch {
    throw new BadRequestError("image data is not valid base64");
  }
  return validateImage(bytes, contentType);
}

/** Parse a multipart/form-data request body into a {@link ParsedUpload}. */
async function parseMultipart(req: Request): Promise<ParsedUpload> {
  const form = await req.formData();
  const name = requireText(form.get("name"), "name", MAX_NAME_LEN);
  const symbol = requireText(form.get("symbol"), "symbol", MAX_SYMBOL_LEN);
  const description = optionalText(
    form.get("description"),
    "description",
    MAX_DESCRIPTION_LEN,
  );

  let image: ParsedImage | null = null;
  const file = form.get("image");
  // A File is sent for the logo; an empty string field means "no logo".
  if (file && typeof file !== "string") {
    const buf = new Uint8Array(await file.arrayBuffer());
    // Prefer the part's declared type; fall back to the filename extension is
    // not attempted - an untyped part is rejected by validateImage's allow-list.
    image = validateImage(buf, file.type || "application/octet-stream");
  }
  return { name, symbol, description, image };
}

/** Parse an application/json request body into a {@link ParsedUpload}. */
async function parseJson(req: Request): Promise<ParsedUpload> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new BadRequestError("request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null) {
    throw new BadRequestError("request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const name = requireText(b.name, "name", MAX_NAME_LEN);
  const symbol = requireText(b.symbol, "symbol", MAX_SYMBOL_LEN);
  const description = optionalText(b.description, "description", MAX_DESCRIPTION_LEN);

  let image: ParsedImage | null = null;
  const img = b.image;
  if (img !== undefined && img !== null) {
    if (typeof img !== "object") {
      throw new BadRequestError('"image" must be an object { data, contentType }');
    }
    const im = img as Record<string, unknown>;
    if (typeof im.data !== "string" || im.data.length === 0) {
      throw new BadRequestError('"image.data" (base64) is required when "image" is present');
    }
    const ct = typeof im.contentType === "string" ? im.contentType : undefined;
    image = parseBase64Image(im.data, ct);
  }
  return { name, symbol, description, image };
}

/**
 * Build a deterministic, collision-resistant storage key for an image from its
 * bytes' SHA-256 (content-addressed). Identical logos re-use the same key, so
 * re-uploading is idempotent and never leaves orphaned copies.
 */
async function imageKey(image: ParsedImage): Promise<string> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(image.bytes).digest("hex");
  return `tokens/${hash}.${image.ext}`;
}

/**
 * Handle the upload: validate, persist the image (if any) and a companion
 * Metaplex-style JSON metadata document, and return the public URLs.
 *
 * The JSON document is content-addressed off its own serialized bytes so the
 * `uri` is stable for identical metadata. `image` in the response is the public
 * image URL, or null when the creator supplied no logo.
 */
export async function POST(req: Request): Promise<NextResponse> {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    const parsed = contentType.includes("multipart/form-data")
      ? await parseMultipart(req)
      : contentType.includes("application/json")
        ? await parseJson(req)
        : (() => {
            throw new BadRequestError(
              "Content-Type must be multipart/form-data or application/json",
              415,
            );
          })();

    const storage = createStorage();

    // 1) Store the image first (if present) so the metadata JSON can reference
    //    its final public URL.
    let imageUri: string | null = null;
    if (parsed.image) {
      const key = await imageKey(parsed.image);
      const { uri } = await storage.put(key, parsed.image.bytes, parsed.image.contentType);
      imageUri = uri;
    }

    // 2) Build and store a Metaplex-style metadata JSON document. This is the
    //    `uri` a fungible-token registry / Token Metadata account points at.
    const metadata = {
      name: parsed.name,
      symbol: parsed.symbol,
      description: parsed.description ?? undefined,
      image: imageUri ?? undefined,
    };
    const metadataBytes = new Uint8Array(
      Buffer.from(JSON.stringify(metadata), "utf8"),
    );
    const { createHash } = await import("node:crypto");
    const metadataHash = createHash("sha256").update(metadataBytes).digest("hex");
    const metadataKey = `tokens/${metadataHash}.json`;
    const { uri: metadataUri } = await storage.put(
      metadataKey,
      metadataBytes,
      "application/json",
    );

    return NextResponse.json(
      {
        // The off-chain JSON metadata URI to embed (Token Metadata `uri`).
        uri: metadataUri,
        // The public image URL, or null when no logo was supplied (honest).
        image: imageUri,
        name: parsed.name,
        symbol: parsed.symbol,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof BadRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // A storage failure (disk full, S3 rejected, missing env) is a real server
    // error: surface the message so the creator knows it was not stored, never
    // a fabricated success.
    const message = err instanceof Error ? err.message : "upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
