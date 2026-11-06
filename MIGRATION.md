# Migrating from GPT Image 2.5

The command line stays the same shape. Three things changed: the model IDs, the
fact that quality is now a first-class flag on every model, and how the estimate
is computed.

## Model IDs

| GPT Image 2.5 | GPT Image 2.6 | Note |
| --- | --- | --- |
| `gpt-image-2.5-flare/text-to-image` | `gpt-image-2.6-flare/text-to-image` | |
| `gpt-image-2.5-flare/image-to-image` | `gpt-image-2.6-flare/image-to-image` | |
| `gpt-image-2.5-sunburst/text-to-image` | `gpt-image-2.6-sunburst/text-to-image` | |
| `gpt-image-2.5-sunburst/image-to-image` | `gpt-image-2.6-sunburst/image-to-image` | |
| `gpt-image-2.5-flare@pro` | `gpt-image-2.6-flare/text-to-image` or `.../image-to-image` | no `@pro` route; the mode follows the reference images |
| `gpt-image-2.5-sunburst@pro` | `gpt-image-2.6-sunburst/text-to-image` or `.../image-to-image` | same |

Pass a 2.5 ID and the CLI maps it, prints one line explaining the mapping, and
sends the 2.6 model. You do not have to change every script at once.

## Flags

| GPT Image 2.5 | GPT Image 2.6 | Why |
| --- | --- | --- |
| `--route pro` | ignored (a note is printed) | every 2.6 model takes `--quality` |
| `--quality low\|medium\|high\|xhigh\|max\|auto` | `--quality low\|medium\|high\|xhigh\|max` | `auto` is gone; omit the flag for the `high` default |
| `--resolution 1K\|2K\|4K` | same, and it now applies to every model | 2.6 prices quality × resolution together |
| `--aspect-ratio` (13 values) | 16 values: adds `5:4`, `4:5`, `2:1`, `1:2`, `9:21`, `3:1`, `1:3` | |
| `--output-format png\|jpeg\|webp` | adds `gif` and `svg` (text-to-image only) | new |
| `--image-url` | still accepted; `--image <path>` is new | local files are uploaded for you |
| — | `--svg`, `--gif`, `--frame-size`, `--frame-count`, `--frame-duration-ms` | new |
| — | `--mask`, `--markup` | local edit targeting |
| — | `--max-cost <usd>` | refuse to submit above a ceiling |
| — | `--update`, `--allow-major`, `--no-auto-update`, `--version` | signed auto-update |

Prompt limit: 20,000 characters on 2.5, **32,000** on 2.6.

## How pricing is computed

2.5 was priced along two separate routes: the mode IDs by `resolution`, the `@pro`
IDs by `quality`. 2.6 has one pricing table per model keyed by **both** `quality`
and `resolution`, plus dedicated rows for SVG and GIF and a per-reference addon on
image-to-image.

The estimate therefore works differently:

- The rule with the **most keys** wins. An SVG request matches `SVG, LOW, 1K`
  (three keys) rather than `LOW, 1K` (two keys).
- GIF rows list all three resolutions in one rule, so the GIF price does not
  change with `--resolution`.
- `image-to-image` adds `$0.012` per reference image before the promotion.
- A live promotion multiplies the total; conflicting promotions are refused by the
  backend, and the estimate then uses list price.

`--dry-run --estimate` prints the matched rule name, so you can see exactly which
row your inputs hit.

## What to check after migrating

1. `--quality auto` no longer exists — delete it and accept the `high` default, or
   pick a tier explicitly.
2. Any `@pro` command keeps working, but the price line it used to match is gone;
   re-run `--estimate` before relying on an old number.
3. `--frame-*` flags require `--gif`; the CLI says so with the exact command to
   add.
