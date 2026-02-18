# PR Summarizer Action

A GitHub Action that **auto-generates pull request titles and descriptions** from the Git diff using an LLM. Falls back to a heuristic summary if no LLM is configured or the API call fails.

---

## What It Does

When a PR is opened or updated, this Action:
- Fetches the diff between `base` and `head` commits.
- Filters out noise (lockfiles, build artifacts, snapshots).
- Calls an LLM to generate a **Conventional-Commit-style title** and a structured **Markdown description** with Summary, Changes, and Notes sections.
- Falls back to a rule-based heuristic if the LLM is unavailable or errors.
- Updates the PR title and/or body automatically.

---

## Quick Start (heuristic only, no API key needed)

Create these two files in your repository:

**1. `.github/workflows/pr-summarize.yml`** — triggers the action on every PR:

```yaml
name: PR Summarize
on:
  pull_request:
    types: [opened, synchronize, edited]

permissions:
  contents: read
  pull-requests: write

jobs:
  summarize:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: mihir7121/pr-summarizer@v1.3.1
        with:
          use-llm: "false"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**2. `.pr-summarizer.yml`** (optional) — repo-level config at your repository root. Overrides the `with:` inputs above, useful for per-repo tuning without editing the workflow:

```yaml
update-title: true
update-body: true
max-files: 60
ignore: "package-lock.json, yarn.lock, pnpm-lock.yaml, dist/**, build/**, **/*.snap"
redact_secrets: true
```

> If you omit `.pr-summarizer.yml`, defaults from the workflow `with:` block are used.

---

## LLM Providers

### OpenAI

Add `OPENAI_API_KEY` as a repository secret, then:

```yaml
- uses: mihir7121/pr-summarizer@v1.3.1
  with:
    use-llm: "true"
    llm-provider: "openai"
    llm-model: "gpt-4o-mini"        # or gpt-4o, gpt-4-turbo, etc.
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### Anthropic Claude

Add `ANTHROPIC_API_KEY` as a repository secret, then:

```yaml
- uses: mihir7121/pr-summarizer@v1.3.1
  with:
    use-llm: "true"
    llm-provider: "anthropic"
    anthropic-model: "claude-3-haiku-20240307"   # cheapest; see model notes below
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Anthropic model options** (cheapest → most capable):

| Model | ID | Notes |
|---|---|---|
| Claude 3 Haiku | `claude-3-haiku-20240307` | Available on all tiers |
| Claude 3.5 Haiku | `claude-3-5-haiku-20241022` | Requires Tier 1+ |
| Claude 3.5 Sonnet | `claude-3-5-sonnet-20241022` | Best quality / cost balance |

> New accounts start on a free tier. Add $5 credit and you'll be on Tier 1, which unlocks `claude-3-5-haiku-20241022` and above.

### Azure OpenAI

Add `AZURE_OPENAI_API_KEY` as a repository secret, then:

```yaml
- uses: mihir7121/pr-summarizer@v1.3.1
  with:
    use-llm: "true"
    llm-provider: "azure_openai"
    llm-model: "your-deployment-name"
    azure-endpoint: "https://YOUR-RESOURCE.openai.azure.com"
    azure-api-version: "2024-06-01"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    AZURE_OPENAI_API_KEY: ${{ secrets.AZURE_OPENAI_API_KEY }}
```

---

## All Inputs

| Input | Default | Description |
|---|---|---|
| `use-llm` | `true` | Enable LLM summarization (falls back to heuristic on failure) |
| `llm-provider` | `openai` | `openai`, `anthropic`, or `azure_openai` |
| `llm-model` | `gpt-4o-mini` | Model name for OpenAI or Azure deployment ID |
| `llm-temperature` | `0.2` | Sampling temperature (0–1) |
| `llm-timeout-ms` | `20000` | API request timeout in milliseconds |
| `llm-max-files` | `30` | Max files to send to the LLM (controls cost) |
| `anthropic-model` | `claude-3-5-haiku-20241022` | Model ID for Anthropic provider |
| `anthropic-api-version` | `2023-06-01` | Anthropic API version header |
| `azure-endpoint` | `` | Azure resource endpoint URL |
| `azure-api-version` | `2024-06-01` | Azure OpenAI API version |
| `update-title` | `true` | Whether to update the PR title |
| `update-body` | `true` | Whether to update the PR body |
| `max-files` | `60` | Max files to analyze (heuristic fallback) |
| `ignore` | `package-lock.json, yarn.lock, ...` | Comma-separated glob patterns to skip |

## Environment Variables

| Variable | Required for | Description |
|---|---|---|
| `GITHUB_TOKEN` | Always | Auto-provided by GitHub Actions |
| `OPENAI_API_KEY` | OpenAI | API key from platform.openai.com |
| `ANTHROPIC_API_KEY` | Anthropic | API key from console.anthropic.com |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI | API key from Azure portal |

---

## Compatible With Any Tech Stack

Because the action operates purely on git diffs — file paths, change status, and patch lines — it works with **any language or framework**:

| Category | Examples |
|---|---|
| Web frontend | JavaScript, TypeScript, React, Vue, Angular, Svelte |
| Backend | Python, Go, Java, C#, Ruby, PHP, Rust, Node.js |
| Mobile | Swift, Kotlin, Dart/Flutter |
| Systems | C, C++, Zig |
| Data / ML | Python notebooks, SQL, dbt models |
| Infra / Config | Terraform, Helm charts, Dockerfiles, GitHub Actions YAML |

The LLM reads the actual diff content and understands the semantics of the change regardless of language, making summaries more meaningful than pattern-matching alone.

---

## Action Tech Stack

- Node 20 runtime (`runs.using: node20`)
- Bundled via esbuild (`--format=cjs`)
- Dependencies: `@actions/core`, `@actions/github`, `minimatch`, `js-yaml`
