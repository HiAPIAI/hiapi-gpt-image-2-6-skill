---
name: hiapi-gpt-image-2-6
description: Use only for HiAPI GPT Image 2.6 image generation and editing with Flare or Sunburst — gpt-image-2.6-flare/text-to-image, gpt-image-2.6-flare/image-to-image, gpt-image-2.6-sunburst/text-to-image and gpt-image-2.6-sunburst/image-to-image. Covers text-to-image, image-to-image, SVG and animated GIF output, mask and markup edits, local reference files uploaded through /v1/uploads, dry-run estimates, --max-cost limits, idempotent async creation, polling, resume, and output download. Do not invoke for GPT Image 2, GPT Image 2.5, other image versions, or unrelated image models.
---

# HiAPI GPT Image 2.6

One command per image. Four model IDs; the CLI picks the mode from your inputs.

| What the user wants | Command |
| --- | --- |
| A picture from text | `node scripts/hiapi-gpt-image-2-6.mjs "a quiet alpine lake at dawn" --quality medium --resolution 2K` |
| Faster iteration | add `--family flare` (the default) |
| More consistent multi-round edits | add `--family sunburst` (better detail at medium quality and above) |
| A logo or icon that scales | add `--svg` |
| A short animation | add `--gif` (`--frame-size`, `--frame-count`, `--frame-duration-ms`) |
| Edit a local photo | `"make the sky purple" --image ./photo.png` |
| Repaint only part of it | add `--mask ./mask.png` (RGBA PNG, same size as the first image) |
| Point at an area instead | add `--markup ./note.png` (never both) |
| Check cost before paying | add `--dry-run --estimate`, optionally `--max-cost 0.10` |
| Get a previous result back | `--resume-task-id <task-id>` (creates nothing) |
| Move a 2.5 command over | keep it: 2.5 model IDs map to 2.6 and the CLI prints the mapping |

## Required order

1. **Preflight.** Run the command with `--dry-run --estimate`. It prints the payload, the matched pricing rule, the active promotion, and `paidTaskCreated: false`. Local files are checked (exist, PNG/JPEG/WebP, under 10 MB) but not uploaded.
2. **One submission.** Remove the preflight flags. The CLI prints the idempotency key and the task ID to stderr immediately; stdout stays JSON. If acceptance is ambiguous, retry with the same `--idempotency-key`.
3. **Recovery.** A timeout or an expired download URL is not a reason to pay twice: `--resume-task-id <task-id>` polls and downloads again.
4. **Quality check.** Verify the file opens, the format matches (`.png`, `.jpg`, `.webp`, `.gif`, `.svg`), the subject and any text are correct, and a mask edit preserved everything outside the marked area.

`--dry-run`, `--estimate`, `--check-contract` and `--version` never create a task. Creating a task spends account balance.

## Field limits

prompt ≤ 32,000 characters after trimming; `quality` low/medium/high/xhigh/max (default high); `resolution` 1K/2K/4K (default 1K); 16 aspect ratios (default auto); `output_format` png/jpeg/webp on both modes, plus gif and svg on text-to-image; `image_urls` 1–16; `output_compression` 0–100 for jpeg/webp; transparent background needs png or webp; GIF requires `aspect_ratio` to stay auto — pass `--aspect-ratio` and the CLI converts it to `frame_size`.

## Automatic updates

Every run checks a signed release manifest. A newer 1.x installs itself on the next run (Ed25519 signature + per-file sha256; the public key is compiled in). Turn it off with `HIAPI_SKILL_AUTO_UPDATE=off` or `--no-auto-update`; update on demand with `--update`; inspect with `--version`. A policy outage never blocks generation, and a native-code change that fails verification leaves the installed copy untouched.

Details: [references/api.md](references/api.md), [references/output.md](references/output.md), [references/workflow.md](references/workflow.md), [references/upgrade-policy.md](references/upgrade-policy.md), [references/local-files.md](references/local-files.md).
