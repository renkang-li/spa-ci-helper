var DEFAULT_TIMEOUT_MS = 60000;
var SPA_CI_HELPER_CONTENT_VERSION = "0.1.5";

globalThis.__spaCiHelperHandleMessage = handleMessage;
globalThis.__spaCiHelperContentVersion = SPA_CI_HELPER_CONTENT_VERSION;

if (!globalThis.__spaCiHelperListenerInstalled) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    globalThis.__spaCiHelperHandleMessage(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  });
  globalThis.__spaCiHelperListenerInstalled = true;
}

async function handleMessage(message) {
  switch (message?.type) {
    case "mergeMr":
      return mergeMr();
    case "gitlabApi":
      return gitlabApi(message.method, message.path);
    case "clickReleaseJobInPipeline":
      return clickReleaseJobInPipeline(message.jobName || "");
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

async function gitlabApi(method, path) {
  const headers = {
    "Accept": "application/json",
    "X-Requested-With": "XMLHttpRequest"
  };

  const response = await fetch(path, {
    method,
    headers,
    credentials: "include"
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_error) {
      data = text;
    }
  }

  if (!response.ok) {
    const detail = typeof data === "string" ? data : data?.message || data?.error || response.statusText;
    return { ok: false, status: response.status, error: `${method} ${path}: ${detail}` };
  }

  return { ok: true, status: response.status, data };
}

async function clickReleaseJobInPipeline(jobName) {
  await waitForPageIdle();

  const directJobLink = findDirectJobLink(jobName);
  if (directJobLink) {
    const status = getJobStatus(directJobLink);
    const href = absoluteUrl(directJobLink.getAttribute("href") || "");
    if (["success", "running", "pending"].includes(status)) {
      return { ok: true, name: jobName, status, href, clicked: false, diagnostics: "direct-link" };
    }

    markTarget(directJobLink);
    await delay(600);
    clickElement(directJobLink);
    return { ok: true, name: jobName, status, href, clicked: true, diagnostics: "direct-link" };
  }

  const gears = await waitForValue(() => {
    const nodes = collectManualGearNodes();
    const items = clickableElements(nodes);
    return items.length ? items : null;
  }, DEFAULT_TIMEOUT_MS);

  if (!gears?.length) {
    return {
      ok: false,
      error: `pipeline 页面未找到手动 job 齿轮；diagnostics=${JSON.stringify(getPipelineDiagnostics(jobName))}`
    };
  }

  const seenMenus = [];

  for (const gear of gears) {
    gear.scrollIntoView({ block: "center", inline: "center" });
    markTarget(gear);
    await delay(500);
    clickElement(gear);

    const menu = await waitForMenuContainingJob(jobName, 10000);

    if (!menu) {
      seenMenus.push(...getVisibleMenuTexts());
      closeMenus();
      await delay(300);
      continue;
    }

    await delay(1200);

    const item = findJobItem(menu, jobName);
    if (item) {
      const status = getJobStatus(item);
      const href = absoluteUrl(item.getAttribute("href") || "");

      if (["success", "running", "pending"].includes(status)) {
        closeMenus();
        return { ok: true, name: jobName, status, href, clicked: false };
      }

      markTarget(item);
      await delay(600);
      setTimeout(() => clickElement(item), 100);
      return { ok: true, name: jobName, status, href, clicked: true };
    }

    seenMenus.push(normalizeText(menu).slice(0, 240));
    closeMenus();
    await delay(300);
  }

  closeMenus();
  return {
    ok: true,
    name: jobName,
    status: "missing",
    href: "",
    clicked: false,
    diagnostics: JSON.stringify({
      gearCount: gears.length,
      menus: seenMenus.slice(0, 6),
      page: location.href
    })
  };
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

function isJobAlreadyRunningOrDone() {
  const text = document.body?.innerText || "";
  return /已通过|passed|success|running|运行中|pending|等待中/i.test(text) && !findButtonByText(/运行|执行|Play|Run/i);
}

function findButtonByText(pattern) {
  return [...document.querySelectorAll("button, a[role='button']")].find((element) => {
    return !element.disabled && isVisible(element) && pattern.test(element.textContent || "");
  });
}

function findDirectJobLink(jobName) {
  const links = [...document.querySelectorAll('a[data-testid="job-with-link"], a[href*="/-/jobs/"], a[href*="/jobs/"]')];
  return links.find((link) => isVisible(link) && normalizeText(link).includes(jobName)) || null;
}

function collectManualGearNodes() {
  const selectors = [
    '[data-testid="status_manual_borderless-icon"]',
    '[data-testid*="manual"][data-testid*="icon"]',
    '[aria-label="status_manual"]',
    '[title*="手动"]',
    '[title*="manual" i]',
    '.ci-status-icon-manual',
    '.js-ci-status-icon-manual',
    'svg[data-testid="status_manual-icon"]'
  ];
  const nodes = [];

  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (!nodes.includes(node)) nodes.push(node);
    }
  }

  return nodes;
}

function clickElement(element) {
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  element.click();
}

function clickableElements(nodes) {
  const seen = new Set();
  const result = [];

  for (const node of nodes) {
    const candidates = [
      node.closest("button, a, [role='button']"),
      node.closest(".gl-dropdown-toggle"),
      node.closest(".js-builds-dropdown-button"),
      node.closest(".ci-action-icon-container"),
      node.closest(".build"),
      node.closest(".stage-cell"),
      node
    ].filter(Boolean);

    for (const clickable of candidates) {
      if (!seen.has(clickable) && isVisible(clickable)) {
        seen.add(clickable);
        result.push(clickable);
      }
    }
  }

  return result;
}

async function waitForMenuContainingJob(jobName, timeoutMs) {
  return waitForValue(() => {
    const menus = getVisibleMenus();
    return menus.find((menu) => normalizeText(menu).includes(jobName)) || null;
  }, timeoutMs);
}

function getVisibleMenus() {
  const selectors = [
    '[data-testid="mini-pipeline-graph-dropdown-menu-list"]',
    '.js-builds-dropdown-list',
    '.gl-dropdown-contents',
    '.dropdown-menu',
    '[role="menu"]'
  ];
  const menus = [];

  for (const selector of selectors) {
    for (const menu of document.querySelectorAll(selector)) {
      if (!menus.includes(menu) && isVisible(menu)) menus.push(menu);
    }
  }

  return menus;
}

function getVisibleMenuTexts() {
  return getVisibleMenus().map((menu) => normalizeText(menu).slice(0, 240)).filter(Boolean);
}

function closeMenus() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function findJobItem(menu, jobName) {
  const links = [...menu.querySelectorAll('a[data-testid="job-with-link"], a[href*="/-/jobs/"], a[href*="/jobs/"]')];
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

function absoluteUrl(href) {
  if (!href) return "";
  return new URL(href, window.location.origin).href;
}

function markTarget(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  element.style.outline = "3px solid #2563eb";
  element.style.outlineOffset = "2px";
}

function getPipelineDiagnostics(jobName) {
  return {
    jobName,
    url: location.href,
    manualNodeCount: collectManualGearNodes().length,
    directJobText: findDirectJobLink(jobName) ? normalizeText(findDirectJobLink(jobName)).slice(0, 160) : "",
    visibleMenuTexts: getVisibleMenuTexts().slice(0, 4)
  };
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
