A tiny GitHub Action that generates a **Conventional Commit**-style PR title and a structured body **without any LLM**. Designed to be the base layer for a later LLM plug-in.


## Permissions
Add to your workflow with `pull-requests: write` and `contents: read`.


## Usage
Create `.github/workflows/pr-summarize.yml` in your repo:


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
                - uses: your-org/pr-summarizer-action@v0
                with:
                    update-title: 'true'
                    update-body: 'true'
                    max-files: '60'
                    ignore: 'package-lock.json, yarn.lock, pnpm-lock.yaml, dist/**, build/**, **/*.snap'
```

## Inputs
- `update-title` (default `true`)
- `update-body` (default `true`)
- `max-files` (default `60`)
- `ignore` (CSV of glob patterns)


## Outputs
- `title`, `body`


## Development
```bash
npm i
npm run build
# produce dist/index.js (bundled by esbuild)
```


## Roadmap
- Add optional LLM provider (OpenAI/Azure/Anthropic) behind `use-llm: true` with strict JSON schema + fallback to heuristic.
- Add secret redaction.
- Add `.pr-summarizer.yml` repo config support.
- Split into reusable library + adapters (Action/App/CLI).