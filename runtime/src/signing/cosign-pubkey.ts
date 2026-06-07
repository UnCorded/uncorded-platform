// Embedded cosign verification key (Phase 01 §10, O4.3).
//
// The release pipeline signs every published runtime image with the matching
// private key (stored in Bitwarden + GitHub Actions secrets as
// `COSIGN_PRIVATE_KEY` + `COSIGN_PASSWORD`). Boot-time signature verification
// (entrypoint.ts) reads this PEM and verifies the orchestrator-supplied
// signature material against it.
//
// **Rotation procedure** (when key is compromised, expired, or operator
// changes hands — see `reference_release_pipeline.md` for the full runbook):
//
//   1. Generate a fresh keypair locally:
//        cosign generate-key-pair
//      (Pick a strong COSIGN_PASSWORD; cosign uses it to encrypt the private
//      half at rest. Both private key and password go into Bitwarden.)
//
//   2. Update Bitwarden entries:
//        uncorded/runtime/COSIGN_PRIVATE_KEY  ← contents of cosign.key
//        uncorded/runtime/COSIGN_PASSWORD     ← the password you chose
//
//   3. Mirror to GitHub Actions secrets at `UnCorded/platform`:
//        gh secret set COSIGN_PRIVATE_KEY --body "$(bw get notes uncorded/runtime/COSIGN_PRIVATE_KEY)"
//        gh secret set COSIGN_PASSWORD    --body "$(bw get password uncorded/runtime/COSIGN_PASSWORD)"
//
//   4. Paste the contents of `cosign.pub` between the backticks below,
//      verbatim — keep the `-----BEGIN PUBLIC KEY-----` / `-----END PUBLIC
//      KEY-----` lines and the trailing newline. Backticks (template literal)
//      are deliberate here so multi-line PEM pastes in without `\n` escape
//      gymnastics. Example shape:
//
//          export const COSIGN_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
//          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...AB==
//          -----END PUBLIC KEY-----
//          `;
//
//      Open a PR titled `runtime: rotate cosign signing key` (or `runtime:
//      embed cosign signing key` for the very first key generation).
//
//   5. After the PR merges, dispatch release-runtime.yml to ship the first
//      image signed by the new key. Old images signed by the prior key still
//      verify against the OLD pubkey — operators on those versions must
//      upgrade before the rotation can be considered complete.
//
// **Empty value handling:** when this constant is empty (the seed state
// before the first key generation), boot-time verification fails closed if
// the orchestrator supplies signature material. Dev / compose environments
// that pass no signature envs continue to work — see entrypoint.ts. The CI
// verify-signature step in release-runtime.yml emits a warning and skips
// verification while this constant is empty, so the FIRST runtime image can
// be built before the key exists; subsequent images MUST be signed by a key
// that matches the embedded value.
export const COSIGN_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzDGdgkP7NvdQjkoGYzvJIQhxfMjQ
PiyRqQJL06K/JWuUpdGdmPlbuv301ggmnX4iPyBHF6KfYskKrUeJrAaS3w==
-----END PUBLIC KEY-----
`;

/** Returns true when a real key has been embedded. False during the pre-first-
 *  release seed period. Boot-time verification uses this to distinguish
 *  "intentionally unverified" from "operator forgot to set up signing". */
export function isCosignPubkeyEmbedded(): boolean {
  return COSIGN_PUBKEY_PEM.trim().length > 0;
}
