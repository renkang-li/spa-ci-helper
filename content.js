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
    case "gitlabApi":
      return gitlabApi(message.method, message.path);
    default:
      return { ok: false, error: "Unknown content message type" };
  }
}

async function mergeMr() {
  await waitForPageIdle();

  if (isMergedPage()) {
    return { ok: true, merged: true, alreadyMerged: true };
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
      return { ok: true, merged: true, alreadyMerged: true };
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

  return { ok: true, merged: true };
}

async function gitlabApi(method, path) {
  const headers = {
    "Accept": "application/json",
    "X-Requested-With": "XMLHttpRequest"
  };
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;

  if (csrf && method !== "GET") {
    headers["X-CSRF-Token"] = csrf;
  }

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
