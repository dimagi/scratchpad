// ==UserScript==
// @name         GitHub PR force-push range-diff command
// @namespace    local.forcepush.rangediff
// @version      0.2
// @description  Show a copy/pasteable `git range-diff` command on each force-push line in a PR.
// @match        https://github.com/*/*/pull/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Optional PAT (repo scope): raises rate limit to 5000/hr and reaches private repos.
  const TOKEN = '';

  const API = 'https://api.github.com';
  const [, owner, repo] = location.pathname.match(/^\/([^/]+)\/([^/]+)\//) || [];
  const prNumber = (location.pathname.match(/\/pull\/(\d+)/) || [])[1];

  const headers = () => Object.assign(
    { Accept: 'application/vnd.github+json' },
    TOKEN ? { Authorization: `token ${TOKEN}` } : {}
  );
  const api = (path) => fetch(`${API}${path}`, { headers: headers() }).then(r => {
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json();
  });

  let basePromise; // cache the PR base ref across clicks
  const baseRef = () => (basePromise ||= api(`/repos/${owner}/${repo}/pulls/${prNumber}`).then(pr => pr.base.ref));

  // merge_base_commit is exactly `git merge-base <base> <head>` — and it's invariant
  // as the base branch grows, so it still yields the historical fork point of an old head.
  const mergeBase = async (head) => {
    const base = await baseRef();
    const cmp = await api(`/repos/${owner}/${repo}/compare/${base}...${head}`);
    return cmp.merge_base_commit.sha;
  };

  async function buildCommand(oldHead, newHead) {
    const [oldBase, newBase] = await Promise.all([mergeBase(oldHead), mergeBase(newHead)]);
    return `git fetch origin ${oldHead} ${newHead} && ` +
           `git range-diff ${oldBase}..${oldHead} ${newBase}..${newHead}`;
  }

  function showCommand(container, cmd) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:6px;align-items:center;margin:6px 0;max-width:100%';
    const input = document.createElement('input');
    input.readOnly = true;
    input.value = cmd;
    input.style.cssText = 'flex:1;font:12px ui-monospace,monospace;padding:4px 6px;' +
      'border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa';
    input.addEventListener('focus', () => input.select());
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.style.cssText = 'font-size:11px;cursor:pointer';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(cmd).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1200);
      });
    });
    wrap.append(input, copy);
    container.replaceChildren(wrap);
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
        showCommand(slot, await buildCommand(oldHead, newHead));
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
