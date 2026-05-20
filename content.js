const DEFAULT_TIMEOUT_MS = 60000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "mergeMr":
      return mergeMr();
    case "findReleaseJobsInPipeline":
      return findReleaseJobsInPipeline(message.jobs || [], message.sourceBranch || "");
    case "playManualJob":
      return playManualJob(message.jobName || "");
    default:
      return { ok: false, error: "Unknown content message type" };
  }
}

async function mergeMr() {
  await waitForPageIdle();
  const sourceBranch = getSourceBranch();

  if (isMergedPage()) {
    return { ok: true, merged: true, alreadyMerged: true, sourceBranch };
  }

  const button = await waitForElement(
    [
      'button[data-testid="merge-button"]',
      'button[data-qa-selector="merge_button"]',
      "button.accept-merge-request"
    ],
    DEFAULT_TIMEOUT_MS
  );

  if (!button) {
    if (isMergedPage()) {
      return { ok: true, merged: true, alreadyMerged: true, sourceBranch };
    }
    return { ok: false, error: "未找到合并按钮" };
  }

  button.scrollIntoView({ block: "center", inline: "center" });
  button.click();

  await clickConfirmIfPresent();
  const merged = await waitForCondition(() => isMergedPage() || !document.contains(button), DEFAULT_TIMEOUT_MS);

  if (!merged) {
    return { ok: false, error: "点击合并后未确认页面已合并" };
  }

  return { ok: true, merged: true, sourceBranch };
}

async function findReleaseJobsInPipeline(expectedJobs, sourceBranch) {
  await waitForPageIdle();

  const row = await waitForValue(() => findPipelineRow(sourceBranch), DEFAULT_TIMEOUT_MS);
  if (!row) {
    return { ok: false, error: "未找到 master pipelines 页面里的 merge pipeline 行" };
  }

  row.scrollIntoView({ block: "center", inline: "center" });

  const found = [];
  const gears = clickableElements(row.querySelectorAll('[data-testid="status_manual_borderless-icon"], [data-testid*="manual"][data-testid*="icon"]'));

  if (!gears.length) {
    return {
      ok: true,
      jobs: expectedJobs.map((name) => ({ name, status: "missing", href: "" }))
    };
  }

  for (const gear of gears) {
    gear.scrollIntoView({ block: "center", inline: "center" });
    gear.click();

    const menu = await waitForElement('[data-testid="mini-pipeline-graph-dropdown-menu-list"], .js-builds-dropdown-list', 10000);
    if (!menu) continue;

    for (const name of expectedJobs) {
      if (found.some((job) => job.name === name)) continue;

      const item = findJobItem(menu, name);
      if (!item) continue;

      found.push({
        name,
        href: absoluteUrl(item.getAttribute("href") || ""),
        status: getJobStatus(item)
      });
    }

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    if (found.length === expectedJobs.length) break;
  }

  for (const name of expectedJobs) {
    if (!found.some((job) => job.name === name)) {
      found.push({ name, status: "missing", href: "" });
    }
  }

  return { ok: true, jobs: found };
}

async function playManualJob(jobName) {
  await waitForPageIdle();

  if (isJobAlreadyRunningOrDone()) {
    return { ok: true, status: "already_started" };
  }

  const button = await waitForElement(
    [
      'button[data-testid="play-job-button"]',
      'button[data-qa-selector="play_job_button"]',
      "button.js-play-job",
      ".js-build-play",
      "button.btn-play"
    ],
    15000
  );

  const fallback = button || findButtonByText(/运行|执行|Play|Run/i);
  if (!fallback) {
    return { ok: false, error: `${jobName || "job"} 页面未找到执行按钮` };
  }

  fallback.scrollIntoView({ block: "center", inline: "center" });
  fallback.click();

  await clickConfirmIfPresent();
  await delay(1500);

  return { ok: true, status: "played" };
}

async function clickConfirmIfPresent() {
  await delay(800);

  const candidates = [
    'button[data-testid="confirm-ok-button"]',
    ".modal button.btn-confirm",
    ".modal button.btn-success",
    ".modal button.gl-button.btn-confirm"
  ];

  for (const selector of candidates) {
    const button = document.querySelector(selector);
    if (button && !button.disabled) {
      button.click();
      return true;
    }
  }

  const modalButtons = [...document.querySelectorAll(".modal button, [role='dialog'] button")];
  const confirmButton = modalButtons.find((item) => /合并|Merge|确认|Confirm/i.test(item.textContent || ""));
  if (confirmButton && !confirmButton.disabled) {
    confirmButton.click();
    return true;
  }

  return false;
}

function isMergedPage() {
  const text = document.body?.innerText || "";
  return /已合并|Merged/i.test(text) && !document.querySelector('button[data-testid="merge-button"], button.accept-merge-request');
}

function getSourceBranch() {
  const refs = [...document.querySelectorAll('a[href*="/-/tree/"]')]
    .map((link) => {
      const match = link.href.match(/\/-\/tree\/(.+)$/);
      return match ? decodeURIComponent(match[1]).replace(/[?#].*$/, "") : "";
    })
    .filter(Boolean)
    .filter((branch) => !["master", "main"].includes(branch));

  if (refs[0]) return refs[0];

  const text = document.body?.innerText || "";
  const patterns = [
    /Merge branch ['"]([^'"]+)['"] into ['"](?:master|main)['"]/i,
    /merge\s+(.+?)\s+into\s+(?:master|main)/i,
    /从\s+(.+?)\s+合并到\s+(?:master|main)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return "";
}

function findPipelineRow(sourceBranch) {
  const rows = getPipelineRows();
  if (!rows.length) return null;

  const visibleRows = rows.filter(isVisible);
  const candidates = visibleRows.length ? visibleRows : rows;

  if (sourceBranch) {
    const exact = candidates.find((row) => normalizeText(row).includes(sourceBranch));
    if (exact) return exact;
  }

  const mergeRow = candidates.find((row) => /Merge branch|合并分支/i.test(normalizeText(row)));
  if (mergeRow) return mergeRow;

  const manualRow = candidates.find((row) => row.querySelector('[data-testid="status_manual_borderless-icon"], [data-testid*="manual"][data-testid*="icon"]'));
  return manualRow || candidates[0] || null;
}

function getPipelineRows() {
  const selectors = [
    '[data-testid="pipeline-row"]',
    ".pipelines .commit",
    "ul.pipelines > li",
    "table tbody tr"
  ];

  const rows = [];
  for (const selector of selectors) {
    for (const row of document.querySelectorAll(selector)) {
      if (!rows.includes(row) && normalizeText(row)) rows.push(row);
    }
  }

  return rows;
}

function clickableElements(nodes) {
  const seen = new Set();
  const result = [];

  for (const node of nodes) {
    const clickable = node.closest("button, a, [role='button']") || node;
    if (!seen.has(clickable) && isVisible(clickable)) {
      seen.add(clickable);
      result.push(clickable);
    }
  }

  return result;
}

function findJobItem(menu, jobName) {
  const links = [...menu.querySelectorAll('a[data-testid="job-with-link"], a[href*="/-/jobs/"]')];
  return links.find((link) => normalizeText(link).includes(jobName)) || null;
}

function getJobStatus(item) {
  const text = `${item.getAttribute("title") || ""} ${normalizeText(item)}`;
  if (/已通过|success|passed/i.test(text)) return "success";
  if (/手动|manual/i.test(text)) return "manual";
  if (/running|运行中/i.test(text)) return "running";
  if (/pending|等待/i.test(text)) return "pending";
  return "unknown";
}

function isJobAlreadyRunningOrDone() {
  const text = document.body?.innerText || "";
  return /已通过|passed|success|running|运行中|pending|等待中/i.test(text) && !findButtonByText(/运行|执行|Play|Run/i);
}

function findButtonByText(pattern) {
  return [...document.querySelectorAll("button, a[role='button']")].find((element) => {
    return !element.disabled && isVisible(element) && pattern.test(element.textContent || "");
  });
}

function absoluteUrl(href) {
  if (!href) return "";
  return new URL(href, window.location.origin).href;
}

function normalizeText(element) {
  return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
}

async function waitForElement(selectors, timeoutMs) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  return waitForValue(() => {
    for (const selector of list) {
      const element = document.querySelector(selector);
      if (element && !element.disabled && isVisible(element)) return element;
    }
    return null;
  }, timeoutMs);
}

async function waitForValue(reader, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const value = reader();
    if (value) return value;
    await delay(300);
  }

  return null;
}

async function waitForCondition(reader, timeoutMs) {
  return Boolean(await waitForValue(() => (reader() ? true : null), timeoutMs));
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function waitForPageIdle() {
  if (document.readyState === "complete") return delay(500);
  return new Promise((resolve) => {
    window.addEventListener("load", () => delay(500).then(resolve), { once: true });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
