/**
 * The Anchor IDL for the Ponk Clouds program, transcribed faithfully from the
 * on-chain `lib.rs` (instructions, events, errors) and `state.rs` (account
 * layouts). It is exported so consumers who prefer can build an
 * `@coral-xyz/anchor` Program from it, and so the SDK's own decoders and
 * error-mapping can reference instruction and account names by symbol.
 *
 * The SDK does NOT depend on @coral-xyz/anchor at runtime: every transaction is
 * built with raw @solana/web3.js for zero-dependency portability. The IDL here
 * is a typed data export plus a precomputed Anchor-error-code map.
 *
 * Anchor custom program errors start at code 6000 and increment in source
 * order of the `#[error_code] enum CloudsError` variants. {@link
 * CLOUDS_ERROR_CODES} encodes that order verbatim so a failed transaction's
 * `Custom(<code>)` can be mapped to a human message via
 * {@link explainCloudsError}.
 */

/** One instruction argument in the IDL. */
export interface IdlField {
  name: string;
  type: string;
}

/** One account a program instruction takes, in its fixed (frozen) order. */
export interface IdlInstructionAccount {
  name: string;
  isMut: boolean;
  isSigner: boolean;
}

/** A program instruction: its name, ordered accounts, and ordered args. */
export interface IdlInstruction {
  name: string;
  accounts: IdlInstructionAccount[];
  args: IdlField[];
}

/** An on-chain account type and its (flat) field layout. */
export interface IdlAccount {
  name: string;
  fields: IdlField[];
}

/** A program-emitted event and its fields. */
export interface IdlEvent {
  name: string;
  fields: IdlField[];
}

/** One Anchor custom error code (>= 6000) with its name and message. */
export interface IdlErrorCode {
  code: number;
  name: string;
  msg: string;
}

/** The full Ponk Clouds IDL shape. */
export type PonkCloudsIdl = {
  version: string;
  name: "ponk_clouds";
  instructions: IdlInstruction[];
  accounts: IdlAccount[];
  events: IdlEvent[];
  errors: IdlErrorCode[];
};

/**
 * The full Ponk Clouds IDL literal. Account orders are FROZEN to match the
 * program's `#[derive(Accounts)]` structs in lib.rs exactly; instruction args
 * match each handler's signature; account field layouts match state.rs; error
 * codes follow the `CloudsError` enum order from 6000.
 */
export const PONK_CLOUDS_IDL: PonkCloudsIdl = {
  version: "0.1.0",
  name: "ponk_clouds",
  instructions: [
    {
      name: "initializePool",
      accounts: [
        { name: "authority", isMut: true, isSigner: true },
        { name: "pool", isMut: true, isSigner: false },
        { name: "mintX", isMut: false, isSigner: false },
        { name: "mintY", isMut: false, isSigner: false },
        { name: "vaultX", isMut: true, isSigner: false },
        { name: "vaultY", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "binStepBps", type: "u16" },
        { name: "swapFeeBps", type: "u16" },
        { name: "protocolFeeBps", type: "u16" },
        { name: "activeBinId", type: "i32" },
      ],
    },
    {
      name: "swap",
      accounts: [
        { name: "user", isMut: true, isSigner: true },
        { name: "pool", isMut: true, isSigner: false },
        { name: "binArray", isMut: true, isSigner: false },
        { name: "vaultX", isMut: true, isSigner: false },
        { name: "vaultY", isMut: true, isSigner: false },
        { name: "userTokenX", isMut: true, isSigner: false },
        { name: "userTokenY", isMut: true, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "amountIn", type: "u64" },
        { name: "minAmountOut", type: "u64" },
        { name: "xForY", type: "bool" },
      ],
    },
    {
      name: "initializeBinArray",
      accounts: [
        { name: "payer", isMut: true, isSigner: true },
        { name: "pool", isMut: false, isSigner: false },
        { name: "binArray", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [{ name: "startBinId", type: "i32" }],
    },
    {
      name: "initializePosition",
      accounts: [
        { name: "owner", isMut: true, isSigner: true },
        { name: "pool", isMut: false, isSigner: false },
        { name: "position", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "lowerBinId", type: "i32" },
        { name: "upperBinId", type: "i32" },
      ],
    },
    {
      name: "addLiquidity",
      accounts: [
        { name: "owner", isMut: true, isSigner: true },
        { name: "pool", isMut: false, isSigner: false },
        { name: "binArray", isMut: true, isSigner: false },
        { name: "position", isMut: true, isSigner: false },
        { name: "vaultX", isMut: true, isSigner: false },
        { name: "vaultY", isMut: true, isSigner: false },
        { name: "userTokenX", isMut: true, isSigner: false },
        { name: "userTokenY", isMut: true, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "binId", type: "i32" },
        { name: "amountX", type: "u64" },
        { name: "amountY", type: "u64" },
      ],
    },
    {
      name: "removeLiquidity",
      accounts: [
        { name: "owner", isMut: true, isSigner: true },
        { name: "pool", isMut: false, isSigner: false },
        { name: "binArray", isMut: true, isSigner: false },
        { name: "position", isMut: true, isSigner: false },
        { name: "vaultX", isMut: true, isSigner: false },
        { name: "vaultY", isMut: true, isSigner: false },
        { name: "userTokenX", isMut: true, isSigner: false },
        { name: "userTokenY", isMut: true, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "binId", type: "i32" },
        { name: "shares", type: "u128" },
      ],
    },
    {
      name: "setPaused",
      accounts: [
        { name: "authority", isMut: false, isSigner: true },
        { name: "pool", isMut: true, isSigner: false },
      ],
      args: [{ name: "paused", type: "bool" }],
    },
    {
      name: "setSwapFee",
      accounts: [
        { name: "authority", isMut: false, isSigner: true },
        { name: "pool", isMut: true, isSigner: false },
      ],
      args: [{ name: "swapFeeBps", type: "u16" }],
    },
    {
      name: "closePosition",
      accounts: [
        { name: "owner", isMut: true, isSigner: true },
        { name: "position", isMut: true, isSigner: false },
      ],
      args: [],
    },
    {
      name: "setProtocolFee",
      accounts: [
        { name: "authority", isMut: false, isSigner: true },
        { name: "pool", isMut: true, isSigner: false },
      ],
      args: [{ name: "protocolFeeBps", type: "u16" }],
    },
    {
      name: "claimProtocolFees",
      accounts: [
        { name: "authority", isMut: false, isSigner: true },
        { name: "pool", isMut: true, isSigner: false },
        { name: "vaultX", isMut: true, isSigner: false },
        { name: "vaultY", isMut: true, isSigner: false },
        { name: "authorityTokenX", isMut: true, isSigner: false },
        { name: "authorityTokenY", isMut: true, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: "initPoolTreasury",
      accounts: [
        { name: "authority", isMut: true, isSigner: true },
        { name: "pool", isMut: false, isSigner: false },
        { name: "poolTreasury", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: "setTreasury",
      accounts: [
        { name: "authority", isMut: false, isSigner: true },
        { name: "pool", isMut: false, isSigner: false },
        { name: "poolTreasury", isMut: true, isSigner: false },
      ],
      args: [{ name: "treasury", type: "publicKey" }],
    },
    {
      name: "setTreasuryFeeBps",
      accounts: [
        { name: "authority", isMut: false, isSigner: true },
        { name: "pool", isMut: false, isSigner: false },
        { name: "poolTreasury", isMut: true, isSigner: false },
      ],
      args: [{ name: "treasuryFeeBps", type: "u16" }],
    },
    {
      name: "claimTreasuryFees",
      accounts: [
        { name: "authority", isMut: false, isSigner: true },
        { name: "pool", isMut: true, isSigner: false },
        { name: "poolTreasury", isMut: true, isSigner: false },
        { name: "vaultX", isMut: true, isSigner: false },
        { name: "vaultY", isMut: true, isSigner: false },
        { name: "treasuryTokenX", isMut: true, isSigner: false },
        { name: "treasuryTokenY", isMut: true, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
      ],
      args: [],
    },
  ],
  accounts: [
    {
      name: "Pool",
      fields: [
        { name: "authority", type: "publicKey" },
        { name: "tokenMintX", type: "publicKey" },
        { name: "tokenMintY", type: "publicKey" },
        { name: "vaultX", type: "publicKey" },
        { name: "vaultY", type: "publicKey" },
        { name: "binStepBps", type: "u16" },
        { name: "swapFeeBps", type: "u16" },
        { name: "protocolFeeBps", type: "u16" },
        { name: "activeBinId", type: "i32" },
        { name: "paused", type: "bool" },
        { name: "bump", type: "u8" },
        { name: "protocolFeeX", type: "u128" },
        { name: "protocolFeeY", type: "u128" },
      ],
    },
    {
      name: "PoolTreasury",
      fields: [
        { name: "pool", type: "publicKey" },
        { name: "treasury", type: "publicKey" },
        { name: "treasuryFeeBps", type: "u16" },
        { name: "bump", type: "u8" },
        { name: "treasuryFeeX", type: "u128" },
        { name: "treasuryFeeY", type: "u128" },
      ],
    },
    {
      name: "BinArray",
      fields: [
        { name: "pool", type: "publicKey" },
        { name: "startBinId", type: "i32" },
        // Vec<BinSlot> of length BINS_PER_ARRAY; each slot is
        // (reserveX u128, reserveY u128, totalShares u128).
        { name: "bins", type: "Vec<BinSlot>" },
        { name: "bump", type: "u8" },
      ],
    },
    {
      name: "Position",
      fields: [
        { name: "owner", type: "publicKey" },
        { name: "pool", type: "publicKey" },
        { name: "lowerBinId", type: "i32" },
        { name: "upperBinId", type: "i32" },
        // Vec<u128>, one share accumulator per bin in [lower, upper].
        { name: "shares", type: "Vec<u128>" },
        { name: "bump", type: "u8" },
      ],
    },
  ],
  events: [
    {
      name: "SwapEvent",
      fields: [
        { name: "pool", type: "publicKey" },
        { name: "xForY", type: "bool" },
        { name: "amountIn", type: "u64" },
        { name: "amountOut", type: "u64" },
        { name: "endBinId", type: "i32" },
      ],
    },
    {
      name: "LiquidityEvent",
      fields: [
        { name: "pool", type: "publicKey" },
        { name: "owner", type: "publicKey" },
        { name: "binId", type: "i32" },
        { name: "isAdd", type: "bool" },
        { name: "amountX", type: "u64" },
        { name: "amountY", type: "u64" },
        { name: "shares", type: "u128" },
      ],
    },
    {
      name: "ClaimProtocolFeesEvent",
      fields: [
        { name: "pool", type: "publicKey" },
        { name: "amountX", type: "u64" },
        { name: "amountY", type: "u64" },
      ],
    },
    {
      name: "ClaimTreasuryFeesEvent",
      fields: [
        { name: "pool", type: "publicKey" },
        { name: "amountX", type: "u64" },
        { name: "amountY", type: "u64" },
      ],
    },
  ],
  // Codes follow the source order of the CloudsError enum, starting at 6000.
  errors: [
    { code: 6000, name: "InvalidBinStep", msg: "bin step must be positive" },
    { code: 6001, name: "InvalidFee", msg: "fee must be below 100%" },
    { code: 6002, name: "Paused", msg: "pool is paused" },
    { code: 6003, name: "WrongPool", msg: "bin array does not belong to this pool" },
    { code: 6004, name: "ActiveBinNotLoaded", msg: "the active bin is not in the loaded bin array" },
    { code: 6005, name: "SwapMath", msg: "swap math failed" },
    { code: 6006, name: "SlippageExceeded", msg: "output below minimum (slippage)" },
    { code: 6007, name: "AmountTooLarge", msg: "amount exceeds u64" },
    { code: 6008, name: "InvalidRange", msg: "invalid bin range" },
    { code: 6009, name: "RangeTooWide", msg: "range wider than one bin array" },
    { code: 6010, name: "BinNotLoaded", msg: "bin is not in the loaded bin array" },
    { code: 6011, name: "BinOutOfPosition", msg: "bin is outside the position range" },
    { code: 6012, name: "LiquidityMath", msg: "liquidity math failed" },
    { code: 6013, name: "ZeroLiquidity", msg: "deposit mints zero shares" },
    { code: 6014, name: "InsufficientShares", msg: "not enough shares" },
    { code: 6015, name: "Overflow", msg: "arithmetic overflow" },
    { code: 6016, name: "WrongMint", msg: "vault mint does not match pool token" },
    { code: 6017, name: "WrongVaultAuthority", msg: "vault authority is not the pool" },
    { code: 6018, name: "Unauthorized", msg: "only the pool authority may do this" },
    { code: 6019, name: "PositionNotEmpty", msg: "position still holds liquidity" },
    {
      code: 6020,
      name: "BelowMinLiquidity",
      msg: "first deposit must mint at least the minimum liquidity",
    },
    {
      code: 6021,
      name: "MisalignedBinArray",
      msg: "bin array start must be aligned to the bin-array grid",
    },
    { code: 6022, name: "TooManyBinArrays", msg: "too many bin arrays passed for one swap" },
    {
      code: 6023,
      name: "WrongBinArrayOwner",
      msg: "a swap bin array is owned by another program",
    },
    { code: 6024, name: "BinArrayNotWritable", msg: "a swap bin array must be writable" },
    { code: 6025, name: "DuplicateBinArray", msg: "duplicate bin array passed to swap" },
    {
      code: 6026,
      name: "NonContiguousBinArrays",
      msg: "swap bin arrays are not a contiguous run",
    },
    {
      code: 6027,
      name: "WrongDirectionBinArray",
      msg: "a swap bin array extends in the wrong direction",
    },
    {
      code: 6028,
      name: "NonCanonicalBinArray",
      msg: "a swap bin array is not the canonical PDA for its start bin id",
    },
  ],
};

/**
 * Anchor custom error code (6000+) -> {name, msg}, derived from the
 * `errors` table above so the two never drift. Use {@link explainCloudsError}
 * to map a raw code from a failed transaction to a human message.
 */
export const CLOUDS_ERROR_CODES: Readonly<Record<number, { name: string; msg: string }>> =
  Object.freeze(
    Object.fromEntries(
      PONK_CLOUDS_IDL.errors.map((e) => [e.code, { name: e.name, msg: e.msg }] as const),
    ),
  );

/**
 * Human-readable message for a Ponk Clouds custom program error code, or null
 * when the code is not one of the program's defined errors (e.g. a Token
 * program or System program error surfaced through the same transaction).
 *
 * @param code The numeric `Custom(<code>)` from a failed transaction.
 * @returns "<Name>: <msg>" for a known code, otherwise null.
 */
export function explainCloudsError(code: number): string | null {
  const entry = CLOUDS_ERROR_CODES[code];
  if (!entry) return null;
  return `${entry.name}: ${entry.msg}`;
}
