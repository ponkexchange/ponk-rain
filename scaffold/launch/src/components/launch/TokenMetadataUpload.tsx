"use client";

/**
 * TokenMetadataUpload - the optional token-metadata step of the launch form.
 *
 * A market creator who is launching a brand-new token can give it a name, a
 * symbol, an optional description, and a logo here. On submit this posts the
 * payload (as multipart/form-data) to the scaffold's own `POST /api/metadata`
 * route, which stores the image and a companion Metaplex-style JSON document via
 * the pluggable storage driver and returns the public `{ uri, image }` URLs the
 * creator then attaches to their token's on-chain Token Metadata account.
 *
 * This step is entirely OPTIONAL and self-contained: it does not block pool
 * creation and does not feed the create transaction (the pool is keyed by mint
 * addresses, not metadata). It is a convenience for hosting a token's off-chain
 * metadata from the same kit.
 *
 * HONESTY (no fabrication, no fake success):
 *   - The form is collapsed by default and clearly labelled optional; skipping
 *     it changes nothing.
 *   - The logo is optional. A creator may register a name/symbol only; the
 *     response then carries `image: null` and nothing is invented.
 *   - The result shows the REAL URLs the route returned. A failure surfaces the
 *     route's actual error message; there is no stubbed success.
 *   - The image preview is a local object URL of the chosen file (revoked on
 *     change/unmount), never a remote placeholder.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

/** The image content types `POST /api/metadata` accepts. Mirrors the route. */
const ACCEPT_IMAGE = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";

/** Max image size the route accepts (1 MiB). Mirrored here for a clear
 * client-side rejection before the upload round-trip. */
const MAX_IMAGE_BYTES = 1024 * 1024;

/** The successful `POST /api/metadata` response shape. */
interface UploadResult {
  /** The off-chain JSON metadata URI to embed (Token Metadata `uri`). */
  uri: string;
  /** The public image URL, or null when no logo was uploaded (honest). */
  image: string | null;
  /** The stored name. */
  name: string;
  /** The stored symbol. */
  symbol: string;
}

/** The submit lifecycle phase. */
type Phase = "idle" | "uploading" | "done" | "error";

/**
 * The optional token-metadata uploader. Renders a collapsed "add token
 * metadata" affordance; expanded, it is a name / symbol / description / logo
 * form that uploads to `POST /api/metadata` and shows the real returned URLs.
 */
export function TokenMetadataUpload() {
  const [open, setOpen] = useState(false);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Maintain a local object-URL preview of the chosen file, revoked whenever it
  // changes or the component unmounts so we never leak blob URLs.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const onPickFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setMessage(null);
    const picked = e.target.files?.[0] ?? null;
    if (picked && picked.size > MAX_IMAGE_BYTES) {
      setFile(null);
      setMessage(
        `Logo is too large (${Math.ceil(picked.size / 1024)} KiB); max ${
          MAX_IMAGE_BYTES / 1024
        } KiB.`,
      );
      // Clear the native input so the same oversized file can be re-picked
      // after the user shrinks it.
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setFile(picked);
  }, []);

  const onSubmit = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedSymbol = symbol.trim();
    if (trimmedName === "" || trimmedSymbol === "") {
      setPhase("error");
      setMessage("Name and symbol are required to host token metadata.");
      return;
    }

    setPhase("uploading");
    setMessage(null);
    setResult(null);
    try {
      const form = new FormData();
      form.set("name", trimmedName);
      form.set("symbol", trimmedSymbol);
      if (description.trim() !== "") form.set("description", description.trim());
      if (file) form.set("image", file);

      const res = await fetch("/api/metadata", {
        method: "POST",
        body: form,
      });
      const body = (await res.json().catch(() => null)) as
        | (Partial<UploadResult> & { error?: string })
        | null;
      if (!res.ok) {
        throw new Error(
          body?.error ?? `metadata upload failed (HTTP ${res.status})`,
        );
      }
      if (!body || typeof body.uri !== "string") {
        throw new Error("metadata upload returned no URI");
      }
      setResult({
        uri: body.uri,
        image: typeof body.image === "string" ? body.image : null,
        name: typeof body.name === "string" ? body.name : trimmedName,
        symbol: typeof body.symbol === "string" ? body.symbol : trimmedSymbol,
      });
      setPhase("done");
    } catch (e) {
      setPhase("error");
      setMessage(e instanceof Error ? e.message : "metadata upload failed");
    }
  }, [name, symbol, description, file]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center justify-between rounded-card border border-dashed border-line bg-panel px-4 py-3 text-left transition-colors hover:border-pink/40"
      >
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-semibold text-fg">
            Add token metadata
            <span className="ml-2 rounded-full border border-line px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">
              optional
            </span>
          </span>
          <span className="text-[11px] text-muted">
            Host a name, symbol, and logo for a brand-new token. Skipping this
            changes nothing.
          </span>
        </span>
        <span className="flex-none text-muted" aria-hidden>
          +
        </span>
      </button>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-panel p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="m-0 text-[13px] font-semibold text-fg">
          Token metadata
          <span className="ml-2 rounded-full border border-line px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">
            optional
          </span>
        </h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-muted hover:text-fg"
        >
          Hide
        </button>
      </div>

      <p className="m-0 text-[11px] leading-relaxed text-muted">
        Upload a name, symbol, and logo for a token you are launching. This hosts
        the off-chain JSON metadata you point your token&apos;s on-chain Token
        Metadata account at. It does not affect pool creation.
      </p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        {/* logo picker + local preview */}
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-20 w-20 flex-none items-center justify-center overflow-hidden rounded-full border border-dashed border-line bg-elevated text-[11px] text-muted transition-colors hover:border-pink/40"
            aria-label="Choose a token logo"
          >
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt="Selected token logo preview"
                className="h-full w-full object-cover"
              />
            ) : (
              "Logo"
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_IMAGE}
            onChange={onPickFile}
            className="hidden"
          />
          {file ? (
            <button
              type="button"
              onClick={() => {
                setFile(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              className="text-[10px] text-muted hover:text-pink"
            >
              Remove
            </button>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              label="Name"
              placeholder="My Token"
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setName(e.target.value)
              }
              maxLength={64}
              wrapperClassName="flex-1"
            />
            <Input
              label="Symbol"
              mono
              placeholder="MYT"
              value={symbol}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setSymbol(e.target.value)
              }
              maxLength={16}
              wrapperClassName="flex-1"
            />
          </div>
          <Input
            label="Description"
            placeholder="Optional"
            value={description}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setDescription(e.target.value)
            }
            maxLength={512}
          />
        </div>
      </div>

      {message ? (
        <p
          className={
            "m-0 text-[11px] " +
            (phase === "error" ? "text-negative" : "text-muted")
          }
        >
          {message}
        </p>
      ) : null}

      {phase === "done" && result ? (
        <div className="flex flex-col gap-1.5 rounded-card border border-line bg-elevated px-3 py-2.5 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted">Metadata URI</span>
            <a
              href={result.uri}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate font-mono text-fg hover:text-pink hover:underline"
            >
              {result.uri}
            </a>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted">Image</span>
            {result.image ? (
              <a
                href={result.image}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate font-mono text-fg hover:text-pink hover:underline"
              >
                {result.image}
              </a>
            ) : (
              <span className="font-mono text-muted">none</span>
            )}
          </div>
        </div>
      ) : null}

      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onSubmit}
          loading={phase === "uploading"}
          disabled={phase === "uploading"}
        >
          {phase === "uploading"
            ? "Uploading..."
            : phase === "done"
              ? "Re-upload"
              : "Upload metadata"}
        </Button>
      </div>
    </section>
  );
}
