const GITLAB_ORIGIN = "https://git.papamk.com";
const POLL_INTERVAL_MS = 3000;
const MERGE_TIMEOUT_MS = 120000;
const PIPELINE_TIMEOUT_MS = 180000;

let state = {
  running: false,
  stopRequested: false,
  logs: [],
  tasks: [],
  options: {
    jobs: ["release-minor", "release-patch"],
    closeSuccessTabs: true,
    visibleExecution: true,
    slowMode: true
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "start":
      if (state.running) return snapshot();
      state = {
        running: true,
        stopRequested: false,
        logs: [],
        tasks: (message.tasks || []).map((task) => ({ ...task, status: "pending", message: "等待执行" })),
        options: {
          jobs: message.options?.jobs?.length ? message.options.jobs : ["release-minor", "release-patch"],
          closeSuccessTabs: message.options?.closeSuccessTabs !== false,
          visibleExecution: message.options?.visibleExecution !== false,
          slowMode: message.options?.slowMode === true
        }
      };
      log(`SPA CI Helper v${chrome.runtime.getManifest().version} 收到开始请求，共 ${state.tasks.length} 个 MR，jobs: ${state.options.jobs.join(", ")}，可视化：${state.options.visibleExecution ? "开" : "关"}，慢速：${state.options.slowMode ? "开" : "关"}`);
      notify();
      processQueue();
      return snapshot();
    case "focusTab":
      await focusTab(message.tabId);
      return snapshot();
    case "stop":
      state.stopRequested = true;
      notify();
      return snapshot();
    case "clear":
      state = {
        running: false,
        stopRequested: false,
        logs: [],
        tasks: [],
        options: state.options
      };
      notify();
      return snapshot();
    case "getState":
      return snapshot();
    default:
      return { ok: false, error: "Unknown message type" };
  }
}

async function processQueue() {
  log("后台队列开始执行");
  for (const task of state.tasks) {
    if (state.stopRequested) {
      updateTask(task.id, { status: "stopped", message: "已停止，剩余任务未执行" });
      continue;
    }

    if (task.status !== "pending") continue;

    try {
      await processTask(task);
    } catch (error) {
      updateTask(task.id, {
        status: "failed",
        message: error.message || "执行失败"
      });
    }
  }

  state.running = false;
  state.stopRequested = false;
  log("后台队列执行结束");
  notify();
}

async function processTask(task) {
  log(`打开 MR：${task.projectPath}!${task.mrIid}`);
  updateTask(task.id, { status: "opening_mr", message: "打开 MR 页面" });
  const tab = await createTab(task.url);
  await focusWindowIfVisible(tab.windowId);
  updateTask(task.id, {
    tabId: tab.id,
    windowId: tab.windowId,
    currentUrl: task.url,
    tabClosed: false
  });
  log(`已创建标签页 #${tab.id}`);

  try {
    const loadedTab = await waitForTabComplete(tab.id);
    setTaskLocation(task.id, loadedTab);
    await pauseForVisualStep(`MR 页面已打开：${task.projectPath}!${task.mrIid}`);

    log(`页面加载完成，准备合并：${task.projectPath}!${task.mrIid}`);
    updateTask(task.id, { status: "merging", message: "等待合并按钮并点击" });
    const mergeResult = await sendToTab(tab.id, {
      type: "mergeMr",
      projectPath: task.projectPath,
      mrIid: task.mrIid
    });

    if (!mergeResult?.ok) {
      throw new Error(mergeResult?.error || "合并点击失败");
    }
    await pauseForVisualStep(`合并点击完成：${task.projectPath}!${task.mrIid}`);

    log(`MR 合并动作完成，读取 merge_commit_sha：${task.projectPath}!${task.mrIid}`);
    updateTask(task.id, { status: "reading_mr", message: "API 查询 merge_commit_sha" });
    const mr = await waitForMergeCommit(tab.id, task);

    log(`拿到 merge_commit_sha：${shortSha(mr.merge_commit_sha)}`);
    updateTask(task.id, {
      sourceBranch: mr.source_branch || mergeResult.sourceBranch || "",
      mergeCommitSha: mr.merge_commit_sha,
      status: "finding_pipeline",
      message: `API 查询 master pipeline：${shortSha(mr.merge_commit_sha)}`
    });

    const pipeline = await waitForPipeline(tab.id, task.projectPath, mr.merge_commit_sha);
    log(`找到 pipeline #${pipeline.id}：${task.projectPath}!${task.mrIid}`);

    const pipelineUrl = pipeline.web_url || `${GITLAB_ORIGIN}/${task.projectPath}/-/pipelines/${pipeline.id}`;
    updateTask(task.id, {
      pipelineId: pipeline.id,
      status: "opening_pipeline",
      message: "打开 pipeline 页面，准备点击齿轮"
    });

    const pipelineTab = await navigateTab(tab.id, pipelineUrl);
    setTaskLocation(task.id, pipelineTab);
    await pauseForVisualStep(`pipeline 页面已打开：#${pipeline.id}`);

    updateTask(task.id, {
      status: "triggering_jobs",
      message: "点击齿轮菜单里的 release job，并在 job 页面执行"
    });

    const jobResult = await playJobsFromPipelineByDom(tab.id, pipelineUrl, state.options.jobs);
    log(`发布 job 结果：${formatJobResult(jobResult)}`);
    updateTask(task.id, {
      status: "done",
      message: formatJobResult(jobResult)
    });

    if (state.options.closeSuccessTabs) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      updateTask(task.id, {
        tabClosed: true,
        currentUrl: ""
      });
      log(`已关闭成功标签页 #${tab.id}`);
    }
  } catch (error) {
    log(`失败：${task.projectPath}!${task.mrIid} - ${error.message || "执行失败"}`);
    updateTask(task.id, {
      status: "failed",
      message: error.message || "执行失败"
    });
  }
}

async function waitForMergeCommit(tabId, task) {
  const start = Date.now();

  while (Date.now() - start < MERGE_TIMEOUT_MS) {
    const response = await gitlabApi(tabId, "GET", `/api/v4/projects/${encodeProject(task.projectPath)}/merge_requests/${task.mrIid}`);
    if (response?.state === "merged" && response.merge_commit_sha) {
      return response;
    }
    await delay(POLL_INTERVAL_MS);
  }

  throw new Error("合并后超时未拿到 merge_commit_sha");
}

async function waitForPipeline(tabId, projectPath, mergeCommitSha) {
  const start = Date.now();
  const query = new URLSearchParams({
    ref: "master",
    sha: mergeCommitSha
  });

  while (Date.now() - start < PIPELINE_TIMEOUT_MS) {
    const pipelines = await gitlabApi(tabId, "GET", `/api/v4/projects/${encodeProject(projectPath)}/pipelines?${query}`);
    if (Array.isArray(pipelines) && pipelines.length > 0) {
      return pipelines[0];
    }
    await delay(POLL_INTERVAL_MS);
  }

  throw new Error(`超时未找到 sha=${shortSha(mergeCommitSha)} 的 master pipeline`);
}

async function playJobsFromPipelineByDom(tabId, pipelineUrl, jobNames) {
  const result = [];

  for (const jobName of jobNames) {
    log(`回到 pipeline 页面，准备点击齿轮菜单：${jobName}`);
    const pipelineTab = await navigateTab(tabId, pipelineUrl);
    const task = state.tasks.find((item) => item.tabId === tabId);
    if (task) {
      setTaskLocation(task.id, pipelineTab);
      await pauseForVisualStep(`pipeline 页面已打开，准备点 ${jobName}`);
    }

    const clickResult = await sendToTab(tabId, {
      type: "clickReleaseJobInPipeline",
      jobName
    });

    if (!clickResult?.ok) {
      result.push({ name: jobName, status: "failed", message: clickResult?.error || "齿轮菜单点击失败" });
      continue;
    }

    if (!clickResult.clicked) {
      result.push({
        name: jobName,
        status: clickResult.status || "missing",
        message: clickResult.diagnostics || ""
      });
      continue;
    }

    log(`已点击齿轮菜单里的 ${jobName}`);
    const jobTab = await waitForTabUrl(tabId, (url) => /\/-\/jobs\/\d+/.test(url), 60000);
    if (task) {
      setTaskLocation(task.id, jobTab);
      await pauseForVisualStep(`job 页面已打开：${jobName}`);
    }

    const playResult = await sendToTab(tabId, {
      type: "playManualJob",
      jobName
    });

    if (!playResult?.ok) {
      result.push({ name: jobName, status: "failed", message: playResult?.error || "DOM 点击执行失败" });
      continue;
    }

    await pauseForVisualStep(`job 执行点击完成：${jobName}`);
    result.push({ name: jobName, status: playResult.status || "played" });
  }

  return result;
}

async function gitlabApi(tabId, method, path) {
  const response = await sendToTab(tabId, {
    type: "gitlabApi",
    method,
    path
  });

  if (!response?.ok) {
    throw new Error(response?.error || `${method} ${path} 失败`);
  }

  return response.data;
}

function updateTask(id, patch) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  Object.assign(task, patch);
  notify();
}

function setTaskLocation(id, tab) {
  if (!tab) return;
  updateTask(id, {
    tabId: tab.id,
    windowId: tab.windowId,
    currentUrl: tab.url || "",
    tabClosed: false
  });
}

function notify() {
  chrome.runtime.sendMessage({ type: "stateUpdated", state: snapshot() }).catch(() => {});
}

function log(message) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  state.logs.push(`[${time}] ${message}`);
  if (state.logs.length > 100) {
    state.logs = state.logs.slice(-100);
  }
  console.log(message);
  notify();
}

function snapshot() {
  return JSON.parse(JSON.stringify(state));
}

function createTab(url) {
  return chrome.tabs.create({ url, active: state.options.visibleExecution });
}

async function focusWindowIfVisible(windowId) {
  if (!state.options.visibleExecution || !windowId) return;
  await chrome.windows.update(windowId, { focused: true }).catch(() => {});
}

function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("页面跳转加载超时"));
    }, 60000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          focusWindowIfVisible(tab.windowId).catch(() => {});
          resolve(tab);
        });
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url, active: state.options.visibleExecution }, () => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(chrome.runtime.lastError.message));
      }
    });
  });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("页面加载超时"));
    }, 60000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(tab);
        });
      }
    }

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (tab.status === "complete") {
        clearTimeout(timer);
        resolve(tab);
        return;
      }

      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

function waitForTabUrl(tabId, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("等待 job 页面跳转超时"));
    }, timeoutMs);

    function done(tab) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    }

    function checkCurrent() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (predicate(tab.url || "")) {
          done(tab);
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error("等待 job 页面跳转超时"));
        }
      });
    }

    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;
      if (predicate(changeInfo.url || tab.url || "")) {
        done(tab);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    checkCurrent();
  });
}

async function focusTab(tabId) {
  if (!Number.isInteger(tabId)) return;

  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  log(`已切换到标签页 #${tabId}`);
}

async function pauseForVisualStep(message) {
  if (!state.options.slowMode) return;
  log(`${message}，暂停 2 秒`);
  await delay(2000);
}

async function sendToTab(tabId, message) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < 15000) {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: runPageAction,
        args: [message]
      });

      return injection?.result;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  throw new Error(lastError?.message || "content script 未响应");
}

async function runPageAction(message) {
  const DEFAULT_TIMEOUT_MS = 60000;

  async function handleMessage(payload) {
    switch (payload?.type) {
      case "mergeMr":
        return mergeMr();
      case "gitlabApi":
        return gitlabApi(payload.method, payload.path);
      case "clickReleaseJobInPipeline":
        return clickReleaseJobInPipeline(payload.jobName || "");
      case "playManualJob":
        return playManualJob(payload.jobName || "");
      default:
        return { ok: false, error: `Unknown page action type: ${payload?.type || ""}` };
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
      if (isMergedPage()) return { ok: true, merged: true, alreadyMerged: true, sourceBranch };
      return { ok: false, error: "未找到合并按钮" };
    }

    button.scrollIntoView({ block: "center", inline: "center" });
    markTarget(button);
    await delay(300);
    clickElement(button);

    // Return quickly. GitLab may reload the page after this click, which would
    // destroy this injected execution context. The background worker verifies
    // the merge by polling the MR API.
    setTimeout(() => {
      clickConfirmIfPresent().catch(() => {});
    }, 300);

    return { ok: true, merged: false, clicked: true, sourceBranch };
  }

  async function gitlabApi(method, path) {
    const response = await fetch(path, {
      method,
      headers: {
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest"
      },
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
      const items = clickableElements(collectManualGearNodes());
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

      await delay(1000);
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
        clickElement(item);
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
    if (!fallback) return { ok: false, error: `${jobName || "job"} 页面未找到执行按钮` };

    markTarget(fallback);
    await delay(400);
    clickElement(fallback);

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
        clickElement(button);
        return true;
      }
    }

    const modalButtons = [...document.querySelectorAll(".modal button, [role='dialog'] button")];
    const confirmButton = modalButtons.find((item) => /合并|Merge|确认|Confirm/i.test(item.textContent || ""));
    if (confirmButton && !confirmButton.disabled) {
      clickElement(confirmButton);
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

  function findButtonByText(pattern) {
    return [...document.querySelectorAll("button, a[role='button']")].find((element) => {
      return !element.disabled && isVisible(element) && pattern.test(element.textContent || "");
    });
  }

  function clickElement(element) {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
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
    const direct = findDirectJobLink(jobName);
    return {
      jobName,
      url: location.href,
      manualNodeCount: collectManualGearNodes().length,
      directJobText: direct ? normalizeText(direct).slice(0, 160) : "",
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

  return handleMessage(message);
}

function formatJobResult(result) {
  return result.map((item) => `${item.name}: ${item.status}${item.message ? `(${item.message})` : ""}`).join("；");
}

function encodeProject(projectPath) {
  return encodeURIComponent(projectPath);
}

function shortSha(sha) {
  return String(sha || "").slice(0, 8);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
