# Output, recovery and delivery

The runtime polls `GET /v1/tasks/{taskId}` until a terminal state. It selects an
output entry whose `type` is `image` (or that has no `type`), accepting `url`,
`image_url` and `imageUrl`, and downloads it into `outputs/` by default.

## Format detection

`--no-save` returns the URL only; treat it as temporary.

| Detected | Requirement |
| --- | --- |
| `.png` | file header `89 50 4E 47` and a png content type |
| `.jpg` | file header `FF D8 FF` and a jpeg content type |
| `.webp` | `RIFF....WEBP` and a webp content type |
| `.gif` | `GIF87a` / `GIF89a` and a gif content type |
| `.svg` | after a BOM, whitespace, an XML declaration, a doctype and comments, the text starts with `<svg`; content type may be `image/svg+xml`, `text/*` or `application/xml` |

A file whose bytes disagree with its content type — HTML served as `image/png`,
or a PNG served as `image/gif` — is refused rather than saved. The error carries
the resume command for the same task.

File names are `gpt-image-2-6-<UTC timestamp>-<uuid>.<ext>`; two concurrent
downloads can never overwrite one another.

## Recovery

A timeout is not a failure. The task keeps running server-side, and
`--resume-task-id <id>` polls and downloads it without creating or charging a
second task. Output URLs also expire; the same resume command fetches a fresh
one.

SVG tasks usually finish within a minute and occasionally take a few minutes;
the timeout message says so.

## Quality check

Technical: the file opens, the extension matches the detected format, the
dimensions fit the requested ratio, transparency exists when requested, and the
GIF actually animates (more than one frame).

Creative: the subject and composition match the prompt, text and logos are
legible and spelled correctly, a mask edit changed only the marked area, and the
result has the rights you need to publish it.

A task ID proves acceptance, not a usable image. Keep the task ID, the
idempotency key, the selected model and the local path for auditing.
