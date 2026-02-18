import * as core from '@actions/core';
import * as github from '@actions/github';
import { Minimatch } from 'minimatch';
import yaml from 'js-yaml';


function debug(msg, obj) {
    core.info(`[pr-summarizer] ${msg}${obj ? ' ' + JSON.stringify(obj) : ''}`);
}


function parseIgnores(ignoreCsv) {
    return ignoreCsv.split(',').map(s => s.trim()).filter(Boolean).map(p => new Minimatch(p, { dot: true }));
}


function isIgnored(path, patterns) {
    return patterns.some(mm => mm.match(path));
}


function countPatch(patch) {
    let add = 0, del = 0;
    if (!patch) return { add, del };
    for (const line of patch.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
        if (line.startsWith('+')) add++;
        else if (line.startsWith('-')) del++;
    }
    return { add, del };
}


function inferType(files) {
    const names = files.map(f => f.filename);
    if (names.some(n => /(^|\/)docs?\//i.test(n) || names.some(n => /README\.md$/i.test(n)))) return 'docs';
    if (names.some(n => /test|spec|_test\.(js|ts|go|py)$/i.test(n))) return 'test';
    if (names.some(n => /fix|hotfix|bug/i.test(n))) return 'fix';
    return 'feat';
}


function scopeFromPaths(files) {
    const counts = new Map();
    for (const f of files) {
        const top = (f.filename.split('/')[0] || 'root').replace(/^(src|pkg|lib)$/, 'core');
        counts.set(top, (counts.get(top) || 0) + 1);
    }
    const arr = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return arr[0]?.[0] || 'core';
}

function makeTitle(files) {
    const type = inferType(files);
    const scope = scopeFromPaths(files);
    // Harvest a hint from filenames
    const hint = files.map(f => f.filename.split('/').slice(-1)[0].replace(/[._-]/g, ' ')).slice(0, 3).join(', ');
    const tail = hint ? `update ${hint}` : 'update';
    let title = `${type}(${scope}): ${tail}`;
    return title.slice(0, 72);
}


function makeBody(files, added, deleted) {
    const lines = [];
    lines.push('### Summary');
    lines.push(`- Files changed: ${files.length}`);
    lines.push(`- Lines: +${added} / -${deleted}`);
    lines.push('');
    lines.push('### Highlights');
    for (const f of files.slice(0, 12)) {
        lines.push(`- ${f.status.toUpperCase()} ${f.filename}`);
    }
    lines.push('');
    lines.push('### Checklist');
    lines.push('- [ ] Tests added/updated');
    lines.push('- [ ] Docs updated');
    lines.push('- [ ] Breaking changes noted');
    lines.push('- [ ] Linked issue(s)');
    return lines.join('\n');
}

async function loadRepoConfig(octokit, owner, repo, ref) {
    try {
        const res = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner, repo, path: '.pr-summarizer.yml', ref,
            headers: { 'X-GitHub-Api-Version': '2022-11-28' }
        });
        if (!res?.data?.content) return null;
        const buff = Buffer.from(res.data.content, 'base64').toString('utf8');
        const cfg = yaml.load(buff) || {};
        return cfg;
    } catch (e) {
        // not found or other error → ignore
        return null;
    }
}

function coalesceConfig(inputs, fileCfg) {
    // normalize keys from YAML (kebab & snake tolerated)
    const get = (obj, keys, fallback) => {
        for (const k of keys) if (obj && obj[k] !== undefined) return obj[k];
        return fallback;
    };
    const ignore = get(fileCfg, ['ignore'], null);
    const maxFiles = get(fileCfg, ['max_files', 'max-files'], null);
    const updateTitle = get(fileCfg, ['update_title', 'update-title'], null);
    const updateBody = get(fileCfg, ['update_body', 'update-body'], null);

    return {
        ignoreCsv: ignore ? (Array.isArray(ignore) ? ignore.join(', ') : String(ignore)) : inputs.ignoreCsv,
        maxFiles: maxFiles ? parseInt(maxFiles, 10) : inputs.maxFiles,
        updateTitle: updateTitle != null ? Boolean(updateTitle) : inputs.updateTitle,
        updateBody: updateBody != null ? Boolean(updateBody) : inputs.updateBody,
    };
}


// To not summarize any secrets in the title, description
function buildRedactors(userPatterns = []) {
    const defaults = [
        /github_pat_[A-Za-z0-9_]{80,}/gi,
        /ghp_[A-Za-z0-9]{30,}/gi,
        /AKIA[0-9A-Z]{16}/g,
        /aws(.{0,20})?(secret|access)?(.{0,20})?key.?[=:]\s*[A-Za-z0-9/+=]{40}/gi,
        /xox[baprs]-[A-Za-z0-9-]{10,48}/g,
        /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWT
        /(api|token|secret|key|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/gi,
        /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/g,
    ];
    const extras = (userPatterns || []).map(p => new RegExp(p, 'g'));
    return [...defaults, ...extras];
}

function redactPatch(patch, redactors) {
    if (!patch) return { redacted: patch, count: 0 };
    let count = 0;
    let out = patch;
    for (const rx of redactors) {
        out = out.replace(rx, () => { count++; return '[REDACTED_SECRET]'; });
    }
    return { redacted: out, count };
}

function trimStr(s, max) { return s.length > max ? s.slice(0, max) : s; }

function buildLLMInput(files, maxFiles, added, deleted) {
    const top = files.slice(0, maxFiles);
    const omitted = files.length - top.length;
    const header = [
        `Total files changed: ${files.length}${omitted > 0 ? ` (showing top ${top.length})` : ''}`,
        `Lines added: +${added}  Lines deleted: -${deleted}`,
        '',
        'Files and diffs:'
    ].join('\n');

    const blocks = top.map((f, i) => {
        const patch = trimStr(f.patch || '(binary or no diff)', 3000);
        const ext = f.filename.split('.').pop() || '';
        return `[${i + 1}] ${f.status.toUpperCase()} ${f.filename}${ext ? ` (.${ext})` : ''}\n${patch}`;
    });

    return header + '\n\n' + blocks.join('\n\n');
}

function parseLLMJson(text) {
    try { return JSON.parse(text); } catch {
        // try to extract JSON block if model added prose
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('invalid JSON from LLM');
        return JSON.parse(m[0]);
    }
}

const LLM_SYSTEM_PROMPT = `You are an expert software engineer writing a pull request summary.
Given a git diff with file changes, write a clear, developer-friendly PR title and description.

Rules:
- Title: follow Conventional Commits (feat/fix/docs/refactor/test/chore/perf), ≤ 72 chars, no trailing period
- Description: use Markdown, structured with ## Summary, ## Changes, and ## Notes sections
  - Summary: 2-4 sentences explaining WHAT changed and WHY (the intent, not just the mechanics)
  - Changes: bullet list of the key logical changes grouped by concern (not just file-by-file)
  - Notes: any breaking changes, migration steps, or reviewer hints (omit section if none)
- Focus on the purpose and impact of the change, not just listing what files were touched
- If test files changed, mention what is now tested
- If configuration/dependency files changed, call that out explicitly

Output strict JSON only — no prose outside the JSON object:
{"title": "...", "description": "..."}`;

async function summarizeWithOpenAI({ key, model, temperature, timeoutMs, content }) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({
                model,
                temperature,
                messages: [
                    { role: 'system', content: LLM_SYSTEM_PROMPT },
                    { role: 'user', content }
                ]
            }),
            signal: ac.signal
        });
        if (!res.ok) throw new Error(`OpenAI ${res.status}`);
        const json = await res.json();
        const msg = json?.choices?.[0]?.message?.content || '{}';
        return parseLLMJson(msg);
    } finally { clearTimeout(t); }
}

async function summarizeWithAzureOpenAI({ key, endpoint, apiVersion, deployment, temperature, timeoutMs, content }) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': key },
            body: JSON.stringify({
                temperature,
                messages: [
                    { role: 'system', content: LLM_SYSTEM_PROMPT },
                    { role: 'user', content }
                ]
            }),
            signal: ac.signal
        });
        if (!res.ok) throw new Error(`AzureOpenAI ${res.status}`);
        const json = await res.json();
        const msg = json?.choices?.[0]?.message?.content || '{}';
        return parseLLMJson(msg);
    } finally { clearTimeout(t); }
}

async function summarizeWithAnthropic({ key, model, apiVersion, temperature, timeoutMs, content }) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': key,
                'anthropic-version': apiVersion
            },
            body: JSON.stringify({
                model,
                max_tokens: 1024,
                temperature,
                system: LLM_SYSTEM_PROMPT,
                messages: [{ role: 'user', content }]
            }),
            signal: ac.signal
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Anthropic ${res.status}: ${errText}`);
        }
        const json = await res.json();
        const msg = json?.content?.[0]?.text || '{}';
        return parseLLMJson(msg);
    } finally { clearTimeout(t); }
}

async function maybeSummarizeWithLLM(opts) {
    const {
        useLLM, provider, model, temperature, timeoutMs,
        files, repoName, branchName, prTitle, maxFiles,
        added, deleted,
        key, azureEndpoint, azureApiVersion,
        anthropicModel, anthropicApiVersion
    } = opts;

    if (!useLLM) return null;
    if (!key) throw new Error('LLM enabled but missing LLM_API_KEY / OPENAI_API_KEY / AZURE_OPENAI_API_KEY / ANTHROPIC_API_KEY');

    const content = [
        `Repo: ${repoName}`,
        `Branch: ${branchName}`,
        prTitle ? `Existing PR title (may be auto-generated, use as weak hint only): ${prTitle}` : '',
        '',
        buildLLMInput(files, maxFiles, added, deleted)
    ].filter(Boolean).join('\n');

    if (provider === 'openai') {
        return summarizeWithOpenAI({ key, model, temperature, timeoutMs, content });
    } else if (provider === 'azure_openai') {
        if (!azureEndpoint) throw new Error('azure-endpoint required for azure_openai provider');
        return summarizeWithAzureOpenAI({
            key, endpoint: azureEndpoint, apiVersion: azureApiVersion, deployment: model,
            temperature, timeoutMs, content
        });
    } else if (provider === 'anthropic') {
        return summarizeWithAnthropic({
            key, model: anthropicModel, apiVersion: anthropicApiVersion,
            temperature, timeoutMs, content
        });
    } else {
        throw new Error(`Unsupported provider: ${provider}. Use openai, azure_openai, or anthropic.`);
    }
}

// Main
async function run() {
    try {
        if (!github.context.payload.pull_request) {
            core.setFailed('This action must run on pull_request events.');
            return;
        }
        const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT;
        if (!token) { core.setFailed('Missing GITHUB_TOKEN in env'); return; }

        const inputUpdateTitle = core.getBooleanInput('update-title');
        const inputUpdateBody = core.getBooleanInput('update-body');
        const inputMaxFiles = parseInt(core.getInput('max-files') || '60', 10);
        const inputIgnoreCsv = core.getInput('ignore') || '';

        const octokit = github.getOctokit(token);
        const pr = github.context.payload.pull_request;
        const { owner, repo } = github.context.repo;

        // Load repo config from head SHA (so PR branches can tweak it)
        const fileCfg = await loadRepoConfig(octokit, owner, repo, pr.head.sha);
        const merged = coalesceConfig(
            { ignoreCsv: inputIgnoreCsv, maxFiles: inputMaxFiles, updateTitle: inputUpdateTitle, updateBody: inputUpdateBody },
            fileCfg || {}
        );

        const ignore = parseIgnores(merged.ignoreCsv);
        const maxFiles = merged.maxFiles;
        const updateTitle = merged.updateTitle;
        const updateBody = merged.updateBody;

        // Compare API
        const base = pr.base.sha; const head = pr.head.sha;
        const compare = await octokit.request('GET /repos/{owner}/{repo}/compare/{base}...{head}', {
            owner, repo, base, head, headers: { 'X-GitHub-Api-Version': '2022-11-28' }
        });

        let files = compare.data.files || [];
        if (ignore.length) files = files.filter(f => !isIgnored(f.filename, ignore));
        if (files.length > maxFiles) files = files.slice(0, maxFiles);

        // Load YAML cfg (we have already added loader); include:
        const redactEnabled = fileCfg?.redact_secrets !== false; // default true
        const userPatterns = Array.isArray(fileCfg?.redact_patterns) ? fileCfg.redact_patterns : [];
        const redactors = redactEnabled ? buildRedactors(userPatterns) : [];

        let totalRedacted = 0;
        for (const f of files) {
            if (!f.patch || !redactEnabled) continue;
            const { redacted, count } = redactPatch(f.patch, redactors);
            f.patch = redacted;
            totalRedacted += count;
        }

        core.info(`[pr-summarizer] redaction ${redactEnabled ? 'on' : 'off'}; matches=${totalRedacted}`);
        let added = 0, deleted = 0;
        for (const f of files) {
            const { add, del } = countPatch(f.patch);
            added += add; deleted += del;
        }

        const repoName = `${owner}/${repo}`;
        const branchName = pr.head.ref;
        const existingPrTitle = pr.title || '';

        const heuristicTitle = makeTitle(files);
        const heuristicBody = makeBody(files, added, deleted);

        let title = heuristicTitle;
        let body = heuristicBody;

        const useLLM = core.getBooleanInput('use-llm');
        const provider = core.getInput('llm-provider') || 'openai';
        const model = core.getInput('llm-model') || 'gpt-4o-mini';
        const temperature = parseFloat(core.getInput('llm-temperature') || '0.2');
        const timeoutMs = parseInt(core.getInput('llm-timeout-ms') || '20000', 10);
        const llmMaxFiles = parseInt(core.getInput('llm-max-files') || '30', 10);
        const azureEndpoint = core.getInput('azure-endpoint') || process.env.AZURE_OPENAI_ENDPOINT || '';
        const azureApiVersion = core.getInput('azure-api-version') || process.env.AZURE_OPENAI_API_VERSION || '2024-06-01';
        const anthropicModel = core.getInput('anthropic-model') || 'claude-3-5-haiku-20241022';
        const anthropicApiVersion = core.getInput('anthropic-api-version') || '2023-06-01';
        const llmKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY
            || process.env.AZURE_OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

        if (useLLM) {
            try {
                const out = await maybeSummarizeWithLLM({
                    useLLM, provider, model, temperature, timeoutMs,
                    files, repoName, branchName, prTitle: existingPrTitle,
                    maxFiles: llmMaxFiles, added, deleted,
                    key: llmKey, azureEndpoint, azureApiVersion,
                    anthropicModel, anthropicApiVersion
                });
                if (out && out.title && out.description) {
                    title = trimStr(out.title, 72);
                    body = out.description;
                    core.info('[pr-summarizer] LLM: success');
                } else {
                    core.info('[pr-summarizer] LLM returned empty/invalid, using heuristic');
                }
            } catch (e) {
                core.info(`[pr-summarizer] LLM error (${provider}): ${e.message}; using heuristic`);
            }
        }

        core.setOutput('title', title);
        core.setOutput('body', body);

        if (updateTitle || updateBody) {
            await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
                owner, repo, pull_number: pr.number,
                title: updateTitle ? title : undefined,
                body: updateBody ? body : undefined,
                headers: { 'X-GitHub-Api-Version': '2022-11-28' }
            });
        }
        core.info(`[pr-summarizer] config: ${JSON.stringify({ ...merged, ignoreCsv: merged.ignoreCsv })}`);

    } catch (err) {
        core.setFailed(err?.message || String(err));
    }
}

run();