# API contract

All four model IDs are called through `POST https://api.hiapi.ai/v1/tasks` with
`Authorization: Bearer $HIAPI_API_KEY`, `Content-Type: application/json`, and an
`Idempotency-Key` of at most 255 UTF-8 bytes. `model` is top level and the
parameters sit inside `input`.

| Model ID | Mode | Output formats |
| --- | --- | --- |
| `gpt-image-2.6-flare/text-to-image` | text-to-image | png, jpeg, webp, gif, svg |
| `gpt-image-2.6-flare/image-to-image` | image-to-image | png, jpeg, webp |
| `gpt-image-2.6-sunburst/text-to-image` | text-to-image | png, jpeg, webp, gif, svg |
| `gpt-image-2.6-sunburst/image-to-image` | image-to-image | png, jpeg, webp |

Flare and Sunburst publish identical schemas in the same mode. The public
descriptions say Flare is the faster model for rapid iteration, and Sunburst
keeps details more consistent across edits at medium quality and above.

## Fields

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `prompt` | string | required | 1–32,000 characters |
| `image_urls` | string[] | required on image-to-image | 1–16 public HTTP(S) URLs |
| `mask_url` | string | — | RGBA PNG, same size as the first source image; never with `markup_url` |
| `markup_url` | string | — | transparent PNG annotation hint; never with `mask_url` |
| `aspect_ratio` | enum | `auto` | `auto`, `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `5:4`, `4:5`, `16:9`, `9:16`, `2:1`, `1:2`, `21:9`, `9:21`, `3:1`, `1:3` |
| `resolution` | enum | `1K` | `1K`, `2K`, `4K` |
| `quality` | enum | `high` | `low`, `medium`, `high`, `xhigh`, `max` |
| `output_format` | enum | `png` | text-to-image: `png`, `jpeg`, `webp`, `gif`, `svg`; image-to-image: `png`, `jpeg`, `webp` |
| `background` | enum | omitted | `auto`, `opaque`, `transparent`; transparent needs png or webp |
| `complexity` | enum | omitted (high) | `low`, `medium`, `high`; planning level, independent of rendering quality |
| `moderation` | enum | omitted (low) | `auto`, `low` |
| `output_compression` | integer | omitted | 0–100; only with jpeg or webp |
| `frame_size` | string | `512x512` | GIF only; `WIDTHxHEIGHT`, both multiples of 16, or `auto` |
| `frame_count` | integer | `9` | GIF only; 2–16 |
| `frame_duration_ms` | integer | `200` | GIF only; ≥20, rounded to 10 ms steps |

The CLI always writes `quality`, `resolution` and `output_format` into the
payload even when they equal the server default, so the estimate and the charge
come from the same pricing row.

## Cross-field rules (`allOf`)

- `background: transparent` requires `output_format` png or webp.
- Any of `frame_size`, `frame_count`, `frame_duration_ms` requires `output_format: gif`.
- `output_compression` requires `output_format` jpeg or webp.
- `output_format: gif` requires `aspect_ratio` to be absent or `auto`.
- On image-to-image, `mask_url` and `markup_url` cannot be combined.

`npm run check:contract` compares this file's rules with the live public schemas.

## GIF

A GIF carries its shape in `frame_size`, not in `aspect_ratio`. Passing
`--aspect-ratio 16:9 --gif` therefore converts the ratio into a `frame_size` with
a 512 px short edge (rounded to multiples of 16) and omits `aspect_ratio`; the
JSON output records that under `adjustments`.

The service tiles frames into one contact sheet. The public description states
the sheet must have edges ≤ 3840, at most 8,294,400 pixels, an aspect ratio ≤ 3:1
and that 768x768 frames support at most 12 frames. A sheet that breaks those
limits is rejected at submission without being charged, so the CLI only warns —
its tiling estimate is a guess, not a contract.

## Prompt caps

`input.prompt.maxLength` is 32,000 characters for all four IDs. The CLI trims
surrounding whitespace and counts JavaScript `string.length` (UTF-16 code units).
Text-to-image also has an internal token cap on the upstream side that returns
`PROMPT_TOO_LONG`; image-to-image does not.

## Pricing and estimates

`--estimate` reads `https://api.hiapi.ai/api/pricing` and `/api/promotions`.
Rules are matched per model: every key in a policy's `rule` must equal the payload
value (`match` may be an array, which is how the GIF rows list 1K/2K/4K), and the
rule with the most keys wins. That is why an SVG request matches `SVG, LOW, 1K`
rather than `LOW, 1K`.

Image-to-image rows also carry a per-reference addon (`image_urls`,
`array_length`, unit price `$0.012`), which the estimate adds once per image
before the promotion multiplier.

A passing `20%` launch promotion is applied when a live, unpaused
`model_promotion` lists the model and is inside its window. Two conflicting
all-user promotions mean no discount is applied — the backend refuses to stack
them. If the promotions feed is unreachable, the estimate uses list price and
says so.

These numbers are dated observations, never a billing guarantee: the accepted
task's actual charge prevails. `--max-cost <usd>` refuses to create a task when
the estimate exceeds the limit, and also when the estimate itself fails.
