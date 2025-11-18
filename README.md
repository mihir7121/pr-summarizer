# 🧠 PR Summarizer Action

A minimal GitHub Action that **auto-generates a pull request title and description** from the Git diff — no LLMs required (yet).  
Built as a foundation for future LLM-powered summarization.

---

## 🚀 What It Does

When a PR is opened or updated, this Action:
- Fetches the diff between `base` and `head` commits.
- Ignores common junk files (lockfiles, build artifacts, snapshots).
- Generates a **Conventional-Commit-style** title (`feat(core): update handler.js`)  
  and a structured body with **Summary**, **Highlights**, and a **Checklist**.
- Updates the PR title/body automatically.

---

## 🧩 Example Output

**Title**: feat(api): update handler.js, utils.go

**Body**:

### Summary
- Files changed: 5
- Lines: +142 / -38

### Highlights
- M pkg/api/handler.go
- A pkg/api/limiter.go
- M utils/validation.go

### Checklist
- [ ] Tests added/updated
- [ ] Docs updated
- [ ] Breaking changes noted
- [ ] Linked issue(s)

## ⚙️ Usage

Add a workflow file at .github/workflows/pr-summarize.yml:
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
        with:
          fetch-depth: 0

      - uses: mihir7121/pr-summarizer@v1
        with:
          update-title: "true"
          update-body: "true"
          max-files: "60"
          ignore: "package-lock.json, yarn.lock, pnpm-lock.yaml, dist/**, build/**, **/*.snap"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```
That's it. Create a PR, and watch title and description automatically populate.

## 🔧 Inputs
| Name | Type | Default | Description |
| :---- | :---: | ----: | ----: |
| update-title | boolean | true | Whether to update the PR title |
| update-body | boolean | true | Whether to update the PR body | 
| max-files | number | 60 | Maximum number of changed files to analyze |
| ignore | string | package-lock.json, yarn.lock, pnpm-lock.yaml, dist/** , build/**, **/*.snap | Comma-separated list of globs to skip |

## 🔐 Environment Variables
| Variable | Required | Description | 
| :---- | :---: | ----: | 
| GITHUB_TOKEN | ✅ Yes | Automatically provided by GitHub — must be passed to the Action as env: | 


## 🧱 Tech Stack
- Node 20 runtime (runs.using: node20)
- Bundled via esbuild (--format=cjs)
- Uses `@actions/core`, `@actions/github`, `minimatch`