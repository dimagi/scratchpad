// ==UserScript==
// @name         GitHub PR force-push range-diff command
// @namespace    local.forcepush.rangediff
// @version      0.3
// @description  Show a copy/pasteable `git range-diff` command on each force-push line in a PR, resolving stacked-branch parents when possible.
// @match        https://github.com/*/*/pull/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // A PAT (repo scope) is REQUIRED for the stacked-branch path (GraphQL force-push
  // history) and for private repos. Without it, the script falls back to merge-base
  // resolution on public repos (60 req/hr).
  const TOKEN = '';

  const API = 'https://api.github.com';
  const [, owner, repo] = location.pathname.match(/^\/([^/]+)\/([^/]+)\//) || [];
  const prNumber = Number((location.pathname.match(/\/pull\/(\d+)/) || [])[1]);

  const ghHeaders = () => Object.assign(
    { Accept: 'application/vnd.github+json' },
    TOKEN ? { Authorization: `token ${TOKEN}` } : {}
  );
  const rest = (path) => fetch(`${API}${path}`, { headers: ghHeaders() }).then(r => {
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json();
  });
  const gql = (query, variables) => fetch(`${API}/graphql`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
    body: JSON.stringify({ query, variables }),
  }).then(async r => {
    const data = await r.json();
    if (!r.ok || data.errors) throw new Error(`graphql ${r.status}: ${JSON.stringify(data.errors || '')}`);
    return data.data;
  });

  // --- commit comparison (cached) --------------------------------------------
  const cmpCache = new Map();
  const compare = (base, head) => {
    const key = `${base}...${head}`;
    if (!cmpCache.has(key)) cmpCache.set(key, rest(`/repos/${owner}/${repo}/compare/${key}`));
    return cmpCache.get(key);
  };

  // Of `candidates`, the one that is an ancestor of `head` and closest to it
  // (fewest commits between). This disambiguates the parent's old vs new tips:
  // only the tip a given head was actually built on is an ancestor of it.
  async function closestAncestor(candidates, head) {
    let best = null;
    for (const c of [...new Set(candidates)]) {
      if (c === head) return c;
      let cmp;
      try { cmp = await compare(c, head); } catch { continue; }
      if ((cmp.status === 'ahead' || cmp.status === 'identical') && (!best || cmp.ahead_by < best.dist)) {
        best = { sha: c, dist: cmp.ahead_by };
      }
    }
    return best && best.sha;
  }

  // --- stacked-branch detection ----------------------------------------------
  // The parent branch ref name if this PR is (or was) stacked on a non-default
  // branch, else null. Handles both "still stacked" (base != default) and
  // "auto-retargeted to default after the parent merged" (base-change events).
  async function detectParentRef() {
    const d = await gql(`
      query($o:String!,$r:String!,$n:Int!){
        repository(owner:$o,name:$r){
          defaultBranchRef{ name }
          pullRequest(number:$n){
            baseRefName
            timelineItems(first:100, itemTypes:[AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT, BASE_REF_CHANGED_EVENT]){
              nodes{
                ... on AutomaticBaseChangeSucceededEvent{ oldBase }
                ... on BaseRefChangedEvent{ previousRefName }
              }
            }
          }
        }
      }`, { o: owner, r: repo, n: prNumber });
    const def = d.repository.defaultBranchRef.name;
    const pr = d.repository.pullRequest;
    if (pr.baseRefName && pr.baseRefName !== def) return pr.baseRefName;
    const events = pr.timelineItems.nodes;
    for (let i = events.length - 1; i >= 0; i--) {
      const old = events[i].oldBase || events[i].previousRefName;
      if (old && old !== def) return old;
    }
    return null;
  }

  // The parent PR's current head + every recorded pre-rebase head, as base candidates.
  async function parentPrTips(ref) {
    const d = await gql(`
      query($q:String!){
        search(query:$q, type:ISSUE, first:5){
          nodes{ ... on PullRequest{
            number headRefOid
            timelineItems(first:100, itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){
              nodes{ ... on HeadRefForcePushedEvent{ beforeCommit{ oid } } }
            }
          }}
        }
      }`, { q: `repo:${owner}/${repo} is:pr head:${ref}` });
    const pr = d.search.nodes.find(n => n && n.headRefOid);
    if (!pr) return null;
    const before = pr.timelineItems.nodes.map(n => n.beforeCommit && n.beforeCommit.oid).filter(Boolean);
    return { number: pr.number, candidates: [pr.headRefOid, ...before] };
  }

  // --- base resolution --------------------------------------------------------
  async function resolveBases(oldHead, newHead) {
    // Preferred: recover bases from the parent PR (needs a token for GraphQL).
    if (TOKEN) {
      try {
        const parentRef = await detectParentRef();
        if (parentRef) {
          const parent = await parentPrTips(parentRef);
          if (parent) {
            const [oldBase, newBase] = await Promise.all([
              closestAncestor(parent.candidates, oldHead),
              closestAncestor(parent.candidates, newHead),
            ]);
            if (oldBase && newBase) {
              return { oldBase, newBase, source: `parent PR #${parent.number} (${parentRef})` };
            }
          }
        }
      } catch (_) { /* fall through to merge-base */ }
    }

    // Fallback: merge-base against the PR's declared base branch.
    const base = (await rest(`/repos/${owner}/${repo}/pulls/${prNumber}`)).base.ref;
    const [oldCmp, newCmp] = await Promise.all([compare(base, oldHead), compare(base, newHead)]);
    const warn = oldCmp.total_commits !== newCmp.total_commits
      ? `old side ${oldCmp.total_commits} vs new ${newCmp.total_commits} commits — likely a stacked branch; old base may over-reach (set a token for parent-PR resolution)`
      : null;
    return { oldBase: oldCmp.merge_base_commit.sha, newBase: newCmp.merge_base_commit.sha, source: `merge-base vs ${base}`, warn };
  }

  function command(oldHead, newHead, oldBase, newBase) {
    return `git fetch origin ${oldHead} ${newHead} && ` +
           `git range-diff ${oldBase}..${oldHead} ${newBase}..${newHead}`;
  }

  function showResult(container, cmd, source, warn) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;margin:6px 0;max-width:100%';
    const input = document.createElement('input');
    input.readOnly = true; input.value = cmd;
    input.style.cssText = 'flex:1;font:12px ui-monospace,monospace;padding:4px 6px;' +
      'border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa';
    input.addEventListener('focus', () => input.select());
    const copy = document.createElement('button');
    copy.textContent = 'Copy'; copy.style.cssText = 'font-size:11px;cursor:pointer';
    copy.addEventListener('click', () => navigator.clipboard.writeText(cmd).then(() => {
      copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1200);
    }));
    row.append(input, copy);

    const caption = document.createElement('div');
    caption.style.cssText = 'font:11px ui-monospace,monospace;color:#57606a;margin:2px 0 6px';
    caption.textContent = `bases via ${source}` + (warn ? `  ⚠️ ${warn}` : '');
    if (warn) caption.style.color = '#9a6700';

    container.replaceChildren(row, caption);
  }

  function attach(item) {
    if (item.dataset.rdAttached) return;
    if (!/force-pushed/.test(item.textContent)) return;
    const shas = [...item.querySelectorAll('a[href*="/commit/"]')]
      .map(a => (a.getAttribute('href').match(/\/commit\/([0-9a-f]{7,40})/) || [])[1])
      .filter(Boolean);
    if (shas.length < 2) return; // need before + after
    item.dataset.rdAttached = '1';
    const [oldHead, newHead] = shas;

    const slot = document.createElement('div');
    const btn = document.createElement('button');
    btn.textContent = 'range-diff cmd';
    btn.style.cssText = 'margin-left:8px;font-size:11px;cursor:pointer';
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Loading…';
      try {
        const { oldBase, newBase, source, warn } = await resolveBases(oldHead, newHead);
        showResult(slot, command(oldHead, newHead, oldBase, newBase), source, warn);
      } catch (e) {
        slot.textContent = `Error: ${e.message}`;
        btn.disabled = false; btn.textContent = 'range-diff cmd';
      }
    });
    item.append(btn, slot);
  }

  const scan = () => document.querySelectorAll('.TimelineItem, .js-timeline-item').forEach(attach);
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
