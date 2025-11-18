import * as core from '@actions/core';
import * as github from '@actions/github';
import { Minimatch } from 'minimatch';


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

async function run() {
    try {
        if (!github.context.payload.pull_request) {
            core.setFailed('This action must run on pull_request events.');
            return;
        }
        const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT;
        if (!token) {
            core.setFailed('Missing GITHUB_TOKEN in env (provided automatically by GitHub).');
            return;
        }


        const updateTitle = core.getBooleanInput('update-title');
        const updateBody = core.getBooleanInput('update-body');
        const maxFiles = parseInt(core.getInput('max-files') || '60', 10);
        const ignoreCsv = core.getInput('ignore') || '';
        const ignore = parseIgnores(ignoreCsv);


        const octokit = github.getOctokit(token);
        const pr = github.context.payload.pull_request;
        const { owner, repo } = github.context.repo;


        // Use the compare API to get patches with limits
        const base = pr.base.sha; const head = pr.head.sha;
        debug('Fetching compare', { base, head });
        const compare = await octokit.request('GET /repos/{owner}/{repo}/compare/{base}...{head}', {
            owner, repo, base, head, headers: { 'X-GitHub-Api-Version': '2022-11-28' }
        });


        let files = compare.data.files || [];
        if (ignore.length) files = files.filter(f => !isIgnored(f.filename, ignore));
        if (files.length > maxFiles) files = files.slice(0, maxFiles);


        let added = 0, deleted = 0;
        for (const f of files) {
            const { add, del } = countPatch(f.patch);
            added += add; deleted += del;
        }


        const title = makeTitle(files);
        const body = makeBody(files, added, deleted);


        core.setOutput('title', title);
        core.setOutput('body', body);


        const prNumber = pr.number;
        if (updateTitle || updateBody) {
            debug('Updating PR', { number: prNumber });
            await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
                owner, repo, pull_number: prNumber,
                title: updateTitle ? title : undefined,
                body: updateBody ? body : undefined,
                headers: { 'X-GitHub-Api-Version': '2022-11-28' }
            });
        }


        core.info(`Title: ${title}`);
        core.info(`Body (first 120 chars): ${body.slice(0, 120)}...`);


    } catch (err) {
        core.setFailed(err?.message || String(err));
    }
}


run();