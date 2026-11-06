# Agent installation

Requires Node.js 18 or newer.

Public install (no git needed):

```bash
npx -y github:HiAPIAI/hiapi-gpt-image-2-6-skill -y
```

`-y` installs into every detected agent skills directory (`~/.codex/skills`,
`~/.claude/skills`). Use one of these to choose explicitly:

```bash
npx -y github:HiAPIAI/hiapi-gpt-image-2-6-skill --target=/path/to/skills
npx -y github:HiAPIAI/hiapi-gpt-image-2-6-skill --codex
npx -y github:HiAPIAI/hiapi-gpt-image-2-6-skill --claude
AGENT_SKILLS_DIR=/path/to/skills npx -y github:HiAPIAI/hiapi-gpt-image-2-6-skill
```

The installer copies only the distributable file set, replaces an existing copy
only when its `SKILL.md` names `hiapi-gpt-image-2-6`, and refuses symlinked
targets.

After installing:

```bash
node scripts/hiapi-gpt-image-2-6.mjs --help
node scripts/hiapi-gpt-image-2-6.mjs --version     # local state, no network
node scripts/check-config.mjs                      # live public contract check
```

Set `HIAPI_API_KEY` only for task creation or recovery. `--dry-run`, `--estimate`
and `--check-contract` never need it.

Updates: signed releases install themselves at the start of a run. Disable with
`HIAPI_SKILL_AUTO_UPDATE=off`; update manually with `--update`. See
[references/upgrade-policy.md](references/upgrade-policy.md).
