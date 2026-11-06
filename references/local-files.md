# Local reference files

`--image`, `--mask` and `--markup` accept either a public HTTPS URL or a local
file. A local file is uploaded to `POST {HIAPI_BASE_URL}/v1/uploads` with the
multipart field `file`, and the returned URL is used in the task payload.

## What the CLI checks before paying

| Check | Where | Failure |
| --- | --- | --- |
| The file exists and is a regular file | `--dry-run` and create | stops before any network call |
| The file is PNG, JPEG or WebP (magic bytes, not the extension) | `--dry-run` and create | lists the accepted types |
| The file is at most 10 MB (the upload API's image limit) | `--dry-run` and create | suggests downscaling or `--image-url` |
| The mask is a PNG with an alpha channel (colour type 6) | `--dry-run` and create | explains how to re-export |
| The mask has the same width and height as the first local image | `--dry-run` and create | prints both sizes |
| The first image's size could not be read (for example a remote URL) | reported as `unchecked` | never a false pass |

`--dry-run` never uploads: it prints the local checks and stops. Uploads happen
only on the paid create path, and each uploaded file is cached by its SHA-256 in
`<cache>/hiapi-gpt-image-2-6/uploads/`, so retrying the same command with the same
idempotency key resends byte-identical URLs instead of re-uploading.

## Object lifetime

Uploaded objects live 24 hours (`expires_at` in the response). The cache honours
that expiry and never reuses a stale URL. Reference URLs the tasks already
accepted are unaffected by a later cache purge.
