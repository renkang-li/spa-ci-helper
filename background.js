const GITLAB_ORIGIN = "https://git.papamk.com";
const BUILD_ID = "minimal-direct-scripting";
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
      return start(message);
    case "stop":
      state.stopRequested = true;
      notify();
      return snapshot();
    case "clear":
      state = { ...state, running: false, stopRequested: false, logs: [], tasks: [] };
      notify();
      return snapshot();
    case "focusTab":
      await focusTab(message.tabId);
      return snapshot();
    case "getState":
      return snapshot();
    case "getBuildInfo":
      return { ok: true, version: chrome.runtime.getManifest().version, buildId: BUILD_ID };
    default:
      return { ok: false, error: "Unknown message type" };
  }
}

function start(message) {
  if (state.running) return snapshot();

  state = {
    running: true,
    stopRequested: false,
    logs: [],
    tasks: (message.tasks || []).map((task) => ({ ...task, status: "pending", message: "等待执行" })),
    options: {
      jobs: message.options?.jobs?.length ? message.options.jobs : ["release-minor", "release-patch"],
      visibleExecution: message.options?.visibleExecution !== false,
      slowMode: message.options?.slowMode === true
    }
  };

  log(`SPA CI Helper v${chrome.runtime.getManifest().version} ${BUILD_ID} 收到开始请求，共 ${state.tasks.length} 个 MR，jobs: ${state.options.jobs.join(", ")}`);
  processQueue();
  return snapshot();
}

async function processQueue() {
  log("后台队列开始执行");

  for (const task of state.tasks) {
    if (state.stopRequested) {
      updateTask(task.id, { status: "stopped", message: "已停止" });
      continue;
    }

    if (task.status !== "pending") continue;

    try {
      await processTask(task);
    } catch (error) {
      log(`失败：${task.projectPath}!${task.mrIid} - ${error.message}`);
      updateTask(task.id, { status: "failed", message: error.message });
    }
  }

  state.running = false;
  state.stopRequested = false;
  log("后台队列执行结束");
  notify();
}

async function processTask(task) {
  updateTask(task.id, { status: "opening_mr", message: "打开 MR 页面" });
  const tab = await chrome.tabs.create({ url: task.url, active: state.options.visibleExecution });
  await focusWindowIfVisible(tab.windowId);
  setTaskTab(task.id, tab);
  log(`已创建标签页 #${tab.id}`);

  setTaskTab(task.id, await waitForTabComplete(tab.id));
  await visualPause(`MR 页面已打开：${task.projectPath}!${task.mrIid}`);

  updateTask(task.id, { status: "merging", message: "DOM 点击合并按钮" });
  const merge = await runPageAction(tab.id, "merge", [], "点击合并按钮");
  if (!merge.ok) throw new Error(merge.error || "合并点击失败");
  await visualPause(`合并点击完成：${task.projectPath}!${task.mrIid}`);

  updateTask(task.id, { status: "reading_mr", message: "API 查询 merge_commit_sha" });
  const mr = await waitForMergeCommit(tab.id, task);
  log(`拿到 merge_commit_sha：${shortSha(mr.merge_commit_sha)}`);

  updateTask(task.id, {
    sourceBranch: mr.source_branch || merge.sourceBranch || "",
    mergeCommitSha: mr.merge_commit_sha,
    status: "finding_pipeline",
    message: `API 查询 master pipeline：${shortSha(mr.merge_commit_sha)}`
  });

  const pipeline = await waitForPipeline(tab.id, task.projectPath, mr.merge_commit_sha);
  const pipelineUrl = pipeline.web_url || `${GITLAB_ORIGIN}/${task.projectPath}/-/pipelines/${pipeline.id}`;
  log(`找到 pipeline #${pipeline.id}`);

  updateTask(task.id, {
    pipelineId: pipeline.id,
    status: "triggering_jobs",
    message: "DOM 点击 pipeline 齿轮和 release job"
  });

  const jobResults = await triggerReleaseJobs(tab.id, pipelineUrl, state.options.jobs);
  updateTask(task.id, { status: "done", message: formatJobResult(jobResults) });
  log(`发布 job 结果：${formatJobResult(jobResults)}`);
}

async function waitForMergeCommit(tabId, task) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < MERGE_TIMEOUT_MS) {
    const mr = await gitlabGet(tabId, `/api/v4/projects/${encodeURIComponent(task.projectPath)}/merge_requests/${task.mrIid}`);
    if (mr?.state === "merged" && mr.merge_commit_sha) return mr;
    await delay(POLL_INTERVAL_MS);
  }

  throw new Error("合并后超时未拿到 merge_commit_sha");
}

async function waitForPipeline(tabId, projectPath, sha) {
  const startedAt = Date.now();
  const query = new URLSearchParams({ ref: "master", sha });

  while (Date.now() - startedAt < PIPELINE_TIMEOUT_MS) {
    const pipelines = await gitlabGet(tabId, `/api/v4/projects/${encodeURIComponent(projectPath)}/pipelines?${query}`);
    if (Array.isArray(pipelines) && pipelines.length > 0) return pipelines[0];
    await delay(POLL_INTERVAL_MS);
  }

  throw new Error(`超时未找到 sha=${shortSha(sha)} 的 master pipeline`);
}

async function gitlabGet(tabId, path) {
  const result = await runPageAction(tabId, "get", [path], `GET ${path}`);
  if (!result.ok) throw new Error(result.error || `GET ${path} 失败`);
  return result.data;
}

async function triggerReleaseJobs(tabId, pipelineUrl, jobs) {
  const results = [];

  for (const jobName of jobs) {
    log(`打开 pipeline 页面，准备点击 ${jobName}`);
    const tab = await navigateTab(tabId, pipelineUrl);
    setTaskByTab(tab);
    await visualPause(`pipeline 页面已打开，准备点 ${jobName}`);

    const click = await runPageAction(tabId, "release", [jobName], `点击 ${jobName}`);
    if (!click.ok) {
      results.push({ name: jobName, status: "failed", message: click.error || "点击 release job 失败" });
      continue;
    }

    if (!click.clicked) {
      results.push({ name: jobName, status: click.status || "missing", message: click.diagnostics || "" });
      continue;
    }

    log(`已点击 ${jobName}`);
    const jobTab = await waitForTabUrl(tabId, (url) => /\/-\/jobs\/\d+/.test(url), 60000);
    setTaskByTab(jobTab);
    await visualPause(`job 页面已打开：${jobName}`);

    const play = await runPageAction(tabId, "play", [jobName], `点击 ${jobName} 执行按钮`);
    results.push(play.ok
      ? { name: jobName, status: play.status || "played" }
      : { name: jobName, status: "failed", message: play.error || "执行按钮点击失败" });
  }

  return results;
}

async function runPageAction(tabId, type, args, label) {
  let lastError = null;

  for (let i = 0; i < 30; i += 1) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url?.startsWith(GITLAB_ORIGIN)) throw new Error(`当前标签页不是 GitLab 页面：${tab.url || ""}`);

      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageAction,
        args: [{ type, args }]
      });

      if (!injection?.result) throw new Error("页面动作没有返回结果");
      return injection.result;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  throw new Error(`${label} 失败：${lastError?.message || "页面脚本未响应"}`);
}

async function pageAction(action) {
  const [firstArg] = action.args || [];

  switch (action.type) {
    case "merge":
      return clickMergeButton();
    case "get":
      return fetchJson(firstArg);
    case "release":
      return clickReleaseJob(firstArg);
    case "play":
      return clickPlayButton(firstArg);
    default:
      return { ok: false, error: `Unknown page action: ${action.type}` };
  }

  function clickMergeButton() {
    const button = findVisible([
      'button[data-testid="merge-button"]',
      'button[data-qa-selector="merge_button"]',
      "button.accept-merge-request"
    ]);

    if (!button) {
      if (/已合并|Merged/i.test(document.body?.innerText || "")) {
        return { ok: true, alreadyMerged: true, sourceBranch: getSourceBranch() };
      }
      return { ok: false, error: "未找到合并按钮" };
    }

    mark(button);
    scheduleClick(button, true);
    return { ok: true, clicked: true, sourceBranch: getSourceBranch() };
  }

  async function fetchJson(path) {
    const response = await fetch(path, {
      method: "GET",
      credentials: "include",
      headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" }
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
      return { ok: false, error: `${response.status}: ${detail}` };
    }

    return { ok: true, data };
  }

  async function clickReleaseJob(jobName) {
    const direct = findJobLink(document, jobName);
    if (direct) return clickJobLink(direct, jobName, "direct-link");

    const gears = collectManualGears();
    const seenMenus = [];

    for (const gear of gears) {
      mark(gear);
      clickElement(gear);

      const menu = await waitForValue(() => visibleMenus().find((item) => textOf(item).includes(jobName)), 5000);
      if (!menu) {
        seenMenus.push(...visibleMenus().map((item) => textOf(item).slice(0, 180)));
        closeMenus();
        await sleep(300);
        continue;
      }

      const link = findJobLink(menu, jobName);
      if (link) return clickJobLink(link, jobName, "gear-menu");

      seenMenus.push(textOf(menu).slice(0, 180));
      closeMenus();
      await sleep(300);
    }

    return {
      ok: true,
      name: jobName,
      status: "missing",
      clicked: false,
      diagnostics: JSON.stringify({ gearCount: gears.length, menus: seenMenus.slice(0, 4), url: location.href })
    };
  }

  function clickPlayButton(jobName) {
    if (/已通过|passed|success|running|运行中|pending|等待中/i.test(document.body?.innerText || "") && !findButton(/运行|执行|Play|Run/i)) {
      return { ok: true, status: "already_started" };
    }

    const button = findVisible([
      'button[data-testid="play-job-button"]',
      'button[data-qa-selector="play_job_button"]',
      "button.js-play-job",
      ".js-build-play",
      "button.btn-play"
    ]) || findButton(/运行|执行|Play|Run/i);

    if (!button) return { ok: false, error: `${jobName} 页面未找到执行按钮` };

    mark(button);
    scheduleClick(button, true);
    return { ok: true, status: "played" };
  }

  function clickJobLink(link, jobName, source) {
    const status = jobStatus(link);
    const href = new URL(link.getAttribute("href") || "", location.origin).href;

    if (["success", "running", "pending"].includes(status)) {
      closeMenus();
      return { ok: true, name: jobName, status, href, clicked: false, diagnostics: source };
    }

    mark(link);
    scheduleClick(link, false);
    return { ok: true, name: jobName, status, href, clicked: true, diagnostics: source };
  }

  function getSourceBranch() {
    return [...document.querySelectorAll('a[href*="/-/tree/"]')]
      .map((link) => decodeURIComponent((link.href.match(/\/-\/tree\/([^?#]+)/) || [])[1] || ""))
      .find((branch) => branch && !["master", "main"].includes(branch)) || "";
  }

  function collectManualGears() {
    const selectors = [
      '[data-testid="status_manual_borderless-icon"]',
      'svg[data-testid="status_manual-icon"]',
      '[aria-label="status_manual"]',
      '.ci-status-icon-manual',
      '.js-ci-status-icon-manual',
      '[title*="手动"]'
    ];
    const nodes = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    const targets = nodes.flatMap((node) => [
      node.closest("button, a, [role='button']"),
      node.closest(".gl-dropdown-toggle"),
      node.closest(".build"),
      node
    ].filter(Boolean));
    return [...new Set(targets)].filter(isVisible);
  }

  function findJobLink(root, jobName) {
    return [...root.querySelectorAll('a[data-testid="job-with-link"], a[href*="/-/jobs/"], a[href*="/jobs/"]')]
      .find((link) => isVisible(link) && textOf(link).includes(jobName)) || null;
  }

  function visibleMenus() {
    return [...document.querySelectorAll('[data-testid="mini-pipeline-graph-dropdown-menu-list"], .js-builds-dropdown-list, .gl-dropdown-contents, .dropdown-menu, [role="menu"]')]
      .filter(isVisible);
  }

  function findVisible(selectors) {
    for (const selector of selectors) {
      const element = [...document.querySelectorAll(selector)].find((item) => !item.disabled && isVisible(item));
      if (element) return element;
    }
    return null;
  }

  function findButton(pattern) {
    return [...document.querySelectorAll("button, a[role='button']")]
      .find((element) => !element.disabled && isVisible(element) && pattern.test(textOf(element))) || null;
  }

  function jobStatus(element) {
    const text = `${element.getAttribute("title") || ""} ${textOf(element)}`;
    if (/已通过|success|passed/i.test(text)) return "success";
    if (/running|运行中/i.test(text)) return "running";
    if (/pending|等待/i.test(text)) return "pending";
    if (/手动|manual/i.test(text)) return "manual";
    return "unknown";
  }

  function scheduleClick(element, confirmAfterClick) {
    setTimeout(() => {
      clickElement(element);
      if (confirmAfterClick) setTimeout(clickConfirm, 500);
    }, 100);
  }

  function clickConfirm() {
    const button = [...document.querySelectorAll(".modal button, [role='dialog'] button, button")]
      .find((item) => !item.disabled && isVisible(item) && /合并|Merge|确认|Confirm|运行|执行|Play|Run/i.test(textOf(item)));
    if (button) clickElement(button);
  }

  function clickElement(element) {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
  }

  function mark(element) {
    element.scrollIntoView({ block: "center", inline: "center" });
    element.style.outline = "3px solid #2563eb";
    element.style.outlineOffset = "2px";
  }

  function closeMenus() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  async function waitForValue(reader, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const value = reader();
      if (value) return value;
      await sleep(200);
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function textOf(element) {
    return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }
}

function updateTask(id, patch) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  Object.assign(task, patch);
  notify();
}

function setTaskTab(id, tab) {
  updateTask(id, { tabId: tab.id, windowId: tab.windowId, currentUrl: tab.url || "" });
}

function setTaskByTab(tab) {
  const task = state.tasks.find((item) => item.tabId === tab.id);
  if (task) setTaskTab(task.id, tab);
}

function notify() {
  chrome.runtime.sendMessage({ type: "stateUpdated", state: snapshot() }).catch(() => {});
}

function log(message) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  state.logs.push(`[${time}] ${message}`);
  state.logs = state.logs.slice(-100);
  console.log(message);
  notify();
}

function snapshot() {
  return JSON.parse(JSON.stringify(state));
}

async function navigateTab(tabId, url) {
  const loaded = waitForTabLoad(tabId);
  await chrome.tabs.update(tabId, { url, active: state.options.visibleExecution });
  const tab = await loaded;
  await focusWindowIfVisible(tab.windowId);
  return tab;
}

function waitForTabComplete(tabId) {
  return chrome.tabs.get(tabId).then((tab) => tab.status === "complete" ? tab : waitForTabLoad(tabId));
}

function waitForTabLoad(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, timeoutMs, new Error("页面加载超时"));

    function done(error, tab) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve(tab);
    }

    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && changeInfo.status === "complete") done(null, tab);
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function waitForTabUrl(tabId, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, timeoutMs, new Error("等待 job 页面跳转超时"));

    function done(error, tab) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve(tab);
    }

    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && predicate(changeInfo.url || tab.url || "")) done(null, tab);
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (predicate(tab.url || "")) done(null, tab);
    }).catch((error) => done(error));
  });
}

async function focusTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await focusWindowIfVisible(tab.windowId);
  log(`已切换到标签页 #${tabId}`);
}

async function focusWindowIfVisible(windowId) {
  if (state.options.visibleExecution && windowId) {
    await chrome.windows.update(windowId, { focused: true }).catch(() => {});
  }
}

async function visualPause(message) {
  if (!state.options.slowMode) return;
  log(`${message}，暂停 2 秒`);
  await delay(2000);
}

function formatJobResult(results) {
  return results.map((item) => `${item.name}: ${item.status}${item.message ? `(${item.message})` : ""}`).join("；");
}

function shortSha(sha) {
  return String(sha || "").slice(0, 8);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
