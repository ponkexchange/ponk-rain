/**
 * Build/version metadata for @ponkrain/sdk.
 *
 * This is a plain data module with no runtime dependencies so it can be
 * imported from anywhere (including the index barrel) without pulling in
 * @solana/web3.js. The version string is kept in sync with package.json by
 * hand on release; it exists so apps can log/report which SDK build they run
 * and so support requests can be matched to a release.
 */

/**
 * Semver of this SDK build. Kept in lockstep with the `version` field in
 * packages/sdk/package.json.
 */
export const SDK_VERSION = "0.1.0";

/**
 * Package name, for diagnostics and user-agent style headers.
 */
export const SDK_NAME = "@ponkrain/sdk";

/**
 * Base58 program id of the Ponk Clouds AMM this SDK targets by default.
 * The canonical, eagerly-constructed PublicKey lives in `constants.ts`
 * (PONK_CLOUDS_PROGRAM_ID); this string copy is dependency-free so version
 * metadata can be read without importing web3.js. RainClient may override the
 * program id at runtime via its options.
 */
export const PONK_CLOUDS_PROGRAM_ID_STR =
  "DJxQvbEtBFngkmtpEcB41Y4qv4apUFsqUvZvG7AHbT7M";

/**
 * One-line human description of what this SDK build targets, handy for splash
 * logs and error reports.
 */
export const SDK_BUILD_INFO = `${SDK_NAME}@${SDK_VERSION} (Ponk Clouds ${PONK_CLOUDS_PROGRAM_ID_STR})` as const;
