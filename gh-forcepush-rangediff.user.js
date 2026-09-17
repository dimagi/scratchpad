// ==UserScript==
// @name         GitHub PR force-push range-diff command
// @namespace    https://github.com/dimagi
// @version      1.2
// @description  Add a clipboard button beside "Compare" on force-push timeline items that copies a `git fetch` + `git range-diff` command.
// @author       Ethan Soergel
// @homepageURL  https://github.com/dimagi/scratchpad/blob/main/gh-forcepush-rangediff.user.js
// @downloadURL  https://raw.githubusercontent.com/dimagi/scratchpad/main/gh-forcepush-rangediff.user.js
// @updateURL    https://raw.githubusercontent.com/dimagi/scratchpad/main/gh-forcepush-rangediff.user.js
// @match        https://github.com/*/*/pull/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const COPY_ICON = '<svg aria-hidden="true" height="16" width="16" viewBox="0 0 16 16" fill="currentColor" class="octicon">' +
    '<path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path>' +
    '<path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path></svg>';
  const CHECK_ICON = '<svg aria-hidden="true" height="16" width="16" viewBox="0 0 16 16" fill="currentColor" class="octicon color-fg-success">' +
    '<path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg>';

  function command(before, after) {
    return `git fetch origin ${before} ${after} && git range-diff ${before}...${after}`;
  }

  function attach(compareLink) {
    if (compareLink.dataset.rangeDiff) return;
    const shas = compareLink.getAttribute('href').match(/\/compare\/([0-9a-f]{7,40})\.\.\.?([0-9a-f]{7,40})/);
    if (!shas) return;
    compareLink.dataset.rangeDiff = '1';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'Button--invisible Button--small Button Button--invisible-noVisuals float-right ml-2';
    button.title = 'Copy git range-diff command';
    button.setAttribute('aria-label', 'Copy git range-diff command');
    button.innerHTML = `<span class="Button-content"><span class="Button-label">${COPY_ICON}</span></span>`;

    const label = button.querySelector('.Button-label');
    button.addEventListener('click', () => {
      navigator.clipboard.writeText(command(shas[1], shas[2])).then(() => {
        label.innerHTML = CHECK_ICON;
        setTimeout(() => { label.innerHTML = COPY_ICON; }, 1200);
      });
    });

    compareLink.insertAdjacentElement('afterend', button);
  }

  const scan = () => document.querySelectorAll('.TimelineItem a.Button[href*="/compare/"]').forEach(attach);

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
