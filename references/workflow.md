# Brief-to-delivery workflow

1. **Outcome.** State the subject, the use, the required shape, and whether the
   result must scale (SVG) or move (GIF). Confirm rights for every reference.
2. **Mode and family.** Reference images mean image-to-image; no reference images
   mean text-to-image. Omit `--family` for the default (Flare, faster iteration)
   and use `--family sunburst` when the brief asks for it or the work is a
   multi-round edit that needs detail held at medium quality and above.
3. **Shape.** Pick `--aspect-ratio`, `--resolution` and `--quality`. For GIF, pass
   `--aspect-ratio` and let the CLI convert it to `frame_size`, or pass
   `--frame-size` directly.
4. **Preflight.** Run with `--dry-run --estimate`. Read the payload (the model ID,
   the explicit defaults, the adjustments) and the estimate (the matched rule,
   the reference addon, the promotion).
5. **Budget.** If the caller gave a ceiling, pass `--max-cost`. A refusal lists
   the estimate and how to bring it down (`--quality`, `--resolution`).
6. **One submission.** Remove the preflight flags. Capture the idempotency key
   and task ID from stderr immediately. On an ambiguous network result, reuse the
   same key — never a new one.
7. **Wait or detach.** The default wait is 30 minutes. `--no-wait` returns after
   submission; `--resume-task-id` picks the task up later.
8. **Download.** The CLI verifies the bytes against the content type and saves
   with the right extension. A refused download is recoverable through resume.
9. **Quality check.** Technical and creative, as in
   [output.md](output.md).
10. **Deliver.** Hand over the artifact plus the prompt and settings that produced
    it. Do not hand over keys, private source media, or expired URLs.
