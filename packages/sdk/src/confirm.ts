/**
 * Send / confirm helpers for `@ponkrain/sdk`.
 *
 * Two independent, dependency-light utilities live here:
 *
 *  1. {@link sendAndConfirm}: prepare (blockhash + fee payer when unset), sign
 *     via a caller-provided callback, broadcast the RAW transaction, and confirm
 *     by POLLING the signature status rather than trusting a (frequently dropped)
 *     WebSocket `signatureSubscribe` notification. This is the single wire-touching
 *     path the high-level {@link RainClient} delegates to; key custody stays with
 *     the caller's `sign` callback.
 *
 *  2. Size-based packing ({@link transactionSize} / {@link packInstructions}):
 *     greedily group a flat instruction list into the fewest legacy transactions
 *     that each fit under the {@link PACKET_DATA_SIZE} wire cap, so a long launch /
 *     deposit bundle can be split into sendable transactions without guessing.
 *
 * Nothing here holds a key, reads program state, or depends on the rest of the
 * SDK; it operates purely on `@solana/web3.js` primitives.
 */

import type {
  Commitment,
  Connection,
  SignatureStatus,
  TransactionInstruction,
  TransactionSignature,
} from "@solana/web3.js";
import { PublicKey, Transaction } from "@solana/web3.js";

/**
 * The Solana wire packet cap, in bytes. A single serialized transaction
 * (signatures + message) must not exceed this. Mirrors web3.js'
 * `PACKET_DATA_SIZE` so the SDK does not depend on its (untyped) re-export.
 */
export const PACKET_DATA_SIZE = 1232;

/** Options controlling {@link sendAndConfirm}'s prepare / broadcast / poll loop. */
export interface SendAndConfirmOptions {
  /**
   * The commitment the signature must reach before this resolves. Defaults to
   * `"confirmed"` (the same default the client uses for reads).
   */
  commitment?: Commitment;
  /**
   * How long to keep polling for confirmation before giving up, in
   * milliseconds. Defaults to 60_000 (roughly a blockhash's lifetime).
   */
  timeoutMs?: number;
  /**
   * The gap between status polls, in milliseconds. Defaults to 1_000.
   */
  pollIntervalMs?: number;
  /**
   * Whether the RPC node should skip its preflight simulation on send.
   * Defaults to `false` (preflight ON) so obvious failures surface immediately.
   */
  skipPreflight?: boolean;
}

/** Rank the cluster's confirmation levels so they can be compared by threshold. */
const CONFIRMATION_RANK: Record<string, number> = {
  processed: 1,
  confirmed: 2,
  finalized: 3,
};

/** True once a polled {@link SignatureStatus} has reached `target` (or higher). */
function statusSatisfies(
  status: SignatureStatus | null | undefined,
  target: Commitment,
): boolean {
  if (!status) return false;
  const level = status.confirmationStatus;
  // The cluster has not yet reported a level: fall back to the confirmation
  // count, which is non-zero once the transaction has been seen + voted on.
  if (level == null) {
    return target === "processed" && (status.confirmations ?? 0) > 0;
  }
  const have = CONFIRMATION_RANK[level] ?? 0;
  // Unknown targets fall back to the "confirmed" threshold (rank 2).
  const want = CONFIRMATION_RANK[target] ?? 2;
  return have >= want;
}

/**
 * Sign, broadcast, and confirm a transaction, returning its signature.
 *
 * The transaction is prepared in place when needed: a fresh `recentBlockhash`
 * (with its `lastValidBlockHeight`) is fetched if absent, and the `feePayer`
 * defaults to the first account the eventual signatures will cover (resolved
 * from the caller's signed transaction). The caller-provided {@link sign}
 * callback owns key custody: it receives the prepared {@link Transaction} and
 * must return it fully signed (e.g. through a wallet adapter). The raw signed
 * bytes are then broadcast and confirmation is established by polling
 * `getSignatureStatuses` until the configured {@link SendAndConfirmOptions.commitment}
 * is reached, which is robust against dropped WebSocket notifications.
 *
 * @param connection  The RPC connection to broadcast and poll on.
 * @param tx          The (optionally pre-built) transaction to send.
 * @param sign        Callback that returns `tx` signed; never receives a key.
 * @param opts        Commitment, timeout, poll interval, and preflight controls.
 * @returns           The confirmed transaction signature.
 * @throws            If signing yields no signature, if the RPC rejects the
 *                    send, or if confirmation is not reached before the timeout.
 */
export async function sendAndConfirm(
  connection: Connection,
  tx: Transaction,
  sign: (tx: Transaction) => Promise<Transaction>,
  opts: SendAndConfirmOptions = {},
): Promise<TransactionSignature> {
  const commitment = opts.commitment ?? "confirmed";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;

  // Prepare: fill in a recent blockhash / last-valid height when unset.
  if (!tx.recentBlockhash) {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash(commitment);
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
  }

  // Hand the prepared transaction to the caller for signing. The fee payer, if
  // still unset after signing, is taken from the first signature's pubkey.
  const signed = await sign(tx);
  const primary = signed.signatures[0];
  if (!primary || primary.signature == null) {
    throw new Error("sendAndConfirm: sign callback returned an unsigned transaction");
  }
  if (!signed.feePayer) {
    signed.feePayer = primary.publicKey;
  }

  const raw = signed.serialize();
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: opts.skipPreflight ?? false,
    preflightCommitment: commitment,
  });

  await confirmSignature(connection, signature, {
    commitment,
    timeoutMs,
    pollIntervalMs,
  });
  return signature;
}

/**
 * Poll `getSignatureStatuses` for a single signature until it reaches
 * `commitment` or the timeout elapses. Exposed for callers that broadcast a
 * transaction themselves (e.g. via a wallet's own send path) and only need the
 * status-polling confirmation.
 *
 * @throws If the transaction reports an on-chain error, or if confirmation is
 *         not reached before `timeoutMs`.
 */
export async function confirmSignature(
  connection: Connection,
  signature: TransactionSignature,
  opts: { commitment?: Commitment; timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const commitment = opts.commitment ?? "confirmed";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: false,
    });
    const status = value[0];
    if (status?.err) {
      throw new Error(
        `Transaction ${signature} failed: ${JSON.stringify(status.err)}`,
      );
    }
    if (statusSatisfies(status, commitment)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Transaction ${signature} was not confirmed within ${timeoutMs}ms ` +
          `(target commitment "${commitment}")`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Serialized size, in bytes, of a legacy transaction carrying `ixs` with
 * `feePayer` as fee payer and `signerCount` total required signatures. The
 * message is built and serialized with a zero blockhash and the signature
 * region is accounted for exactly (`1 + 64 * signerCount`), so the result is
 * the true wire size up to the (fixed-length) blockhash. Pure; no RPC.
 *
 * @param ixs          The instructions the transaction would carry.
 * @param feePayer     The fee payer (also signer 0).
 * @param signerCount  Total required signers (>= 1); defaults to 1.
 */
export function transactionSize(
  ixs: TransactionInstruction[],
  feePayer: PublicKey,
  signerCount = 1,
): number {
  const tx = new Transaction();
  tx.feePayer = feePayer;
  // A zero blockhash is fixed-length, so it does not perturb the size estimate.
  tx.recentBlockhash = PublicKey.default.toBase58();
  tx.add(...ixs);
  const message = tx.compileMessage().serialize();
  const signatures = 1 + 64 * Math.max(1, signerCount);
  return signatures + message.length;
}

/**
 * Greedily pack a flat instruction list into the fewest legacy transactions
 * that each serialize under {@link PACKET_DATA_SIZE}, preserving order.
 *
 * Instructions are appended to the current group until the next one would push
 * the serialized size over the cap, at which point a new group is started. An
 * instruction that cannot fit even alone (always carries the full signer
 * overhead) throws, since no legacy transaction could ever carry it.
 *
 * @param ixs          The ordered instructions to pack.
 * @param feePayer     The fee payer used for every group's size accounting.
 * @param signerCount  Total required signers per group (>= 1); defaults to 1.
 * @returns            Ordered groups, each fitting the wire cap.
 * @throws             If a single instruction exceeds the cap on its own.
 */
export function packInstructions(
  ixs: TransactionInstruction[],
  feePayer: PublicKey,
  signerCount = 1,
): TransactionInstruction[][] {
  const groups: TransactionInstruction[][] = [];
  let current: TransactionInstruction[] = [];

  for (const ix of ixs) {
    const candidate = [...current, ix];
    if (transactionSize(candidate, feePayer, signerCount) <= PACKET_DATA_SIZE) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw new Error(
        "packInstructions: a single instruction exceeds the transaction size cap",
      );
    }
    groups.push(current);
    current = [ix];
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Resolve after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
