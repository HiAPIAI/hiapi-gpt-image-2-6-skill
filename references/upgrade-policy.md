# Upgrade and auto-update policy

Two mechanisms ship together: the **soft/hard version policy** inherited from
GPT Image 2.5, and the **signed auto-update** that installs a verified release in
the background.

## Policy sources

1. `https://raw.githubusercontent.com/HiAPIAI/hiapi-skills/main/skills.json` — the
   `hiapi-gpt-image-2-6` entry.
2. `https://raw.githubusercontent.com/HiAPIAI/hiapi-gpt-image-2-6-skill/main/update-policy.json`.

Each read has a 4-second timeout. One read per run, never for `--help` or
`--version`. If both fail, the run continues and the JSON output is marked
`unverified`; a policy outage never becomes a generation outage.

| Condition | Behaviour |
| --- | --- |
| `current < minimumVersion` | hard upgrade: only paid creation is blocked; `--dry-run`, `--estimate`, `--resume-task-id` and downloads still work |
| `current < latestVersion`, same major | soft upgrade: a notice, creation continues |
| `latestVersion` is a new major | notice only; installing it needs `--update --allow-major` |
| sources unreachable | `unverified`; creation continues |

## Signed auto-update

The private key never leaves the maintainer's machine. Releases are signed with
Ed25519; the public half is a literal in `scripts/lib/update.mjs` and cannot be
overridden by an environment variable.

1. Read the manifest `release/manifest.json` and its signature
   `release/manifest.sig` from
   `https://raw.githubusercontent.com/HiAPIAI/hiapi-gpt-image-2-6-skill/v<version>/`.
2. Verify the signature over the raw manifest bytes with the trusted key whose id
   matches `keyId`.
3. Require the manifest's `skillId` to match, its `version` to equal the published
   `latestVersion`, and that version to be greater than the installed one (no
   downgrades).
4. Download every listed file (total budget 30 s, each file ≤ 5 MB, no `..`, no
   absolute paths) and verify the size and sha256 of each.
5. Take `update.lock` in the cache directory (atomic `wx` create; a lock older
   than 5 minutes is considered abandoned).
6. Back up the currently installed files to `<cache>/hiapi-gpt-image-2-6/prev-<version>/`,
   then write each file under a temporary name and rename it into place.
7. Delete only files that the previous release listed and the new one does not —
   never `outputs/`, `.env`, or any file the release does not own.
8. Write `.hiapi-skill-installed.json` last, then release the lock.

Any failure before step 8 restores the backup, and the run degrades to a notice.
The cache lives outside the skills directory on purpose: a backup inside it would
look like a second copy of the skill to the agent.

### Conditions

The update is skipped when any of these is true: `HIAPI_SKILL_AUTO_UPDATE` is
`off`/`0`/`false`, `--no-auto-update` was passed, `CI=true`, the skill directory
is a git checkout (the run suggests `git pull`), the directory is not writable, or
the process is a re-executed child (`HIAPI_SKILL_REEXEC=1`).

### What the user sees

A successful update prints one line to stderr:

```
Auto-updated hiapi-gpt-image-2-6 1.0.0 → 1.0.1 (signature verified). Takes effect on the next run; re-read SKILL.md if your agent cached it.
```

The current run keeps running the code it loaded. A **hard** upgrade instead
re-executes the same command on the new entry point (marked so it cannot loop), so
the caller notices nothing.

### Commands

| Command | Effect |
| --- | --- |
| `--update` | check and install now; prints the result as JSON |
| `--update --allow-major` | also accept a new major |
| `--version` | local version, install marker, git state, auto-update switch — no network |
| `HIAPI_SKILL_AUTO_UPDATE=off` | disable the automatic path |
| `HIAPI_SKIP_UPDATE_CHECK=1` | skip the policy read entirely |
| `HIAPI_SKILL_CACHE_DIR=<dir>` | move the cache, lock and backups |

### Key rotation

Adding a key means shipping a signed release whose `scripts/lib/update.mjs`
contains the new key id in `TRUSTED_KEYS`. A manifest signed with an unknown id is
refused, so a stolen repository cannot authorise itself.
