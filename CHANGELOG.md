# Changelog

## 1.0.0 — 2026-11-06

- First release of the GPT Image 2.6 skill for `gpt-image-2.6-flare/text-to-image`,
  `gpt-image-2.6-flare/image-to-image`, `gpt-image-2.6-sunburst/text-to-image` and
  `gpt-image-2.6-sunburst/image-to-image`.
- `--svg` and `--gif` flags: SVG output is verified as vector text, GIF converts a
  non-auto `--aspect-ratio` into `frame_size` and warns (never blocks) about an
  oversized contact sheet.
- Local reference files: `--image`, `--mask`, `--markup` accept paths, are checked
  offline (type, size, RGBA mask, matching dimensions), uploaded through
  `/v1/uploads` only on the paid path, and cached by content hash so a retried
  idempotency key resends identical URLs.
- `--estimate` matches the most specific pricing rule, adds the reference-image
  addon, applies live promotions, and never invents a discount.
  `--max-cost` refuses to submit above the limit, and also when the estimate fails.
- Every JSON result, success or failure, carries a `next` field with a runnable
  command: missing key, 401/403, 402, 429, invalid request, `PROMPT_TOO_LONG`,
  ambiguous acceptance, timeout, expired download, and a blocked hard update.
- GPT Image 2.5 model IDs and `--route pro` are mapped onto 2.6 with a printed
  note; `MIGRATION.md` documents every flag change.
- Signed auto-update: Ed25519 manifest signature with a compiled-in public key,
  per-file sha256, 30-second download budget, file lock, backup outside the skills
  directory, rollback on failure, and a hard-upgrade re-exec that cannot loop.
- Live contract check compares the four public schemas (fields, required keys,
  enums, defaults, bounds, `allOf` rules) and the pricing-row structure, never
  amounts.
