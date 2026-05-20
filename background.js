const GITLAB_ORIGIN = "https://git.papamk.com";
const BUILD_ID = "precheck-api-job-dom-play";
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
  const beforeMerge = await getMergeRequest(tab.id, task);
  const skipReason = getMergeSkipReason(beforeMerge);
  if (skipReason) {
    updateTask(task.id, { status: "skipped", message: skipReason });
    log(`跳过：${task.projectPath}!${task.mrIid} - ${skipReason}`);
    return;
  }

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
  log(`找到 pipeline #${pipeline.id}`);

  updateTask(task.id, {
    pipelineId: pipeline.id,
    status: "triggering_jobs",
    message: "API 定位 release job，DOM 点击执行"
  });

  const jobs = await findPipelineJobs(tab.id, task.projectPath, pipeline.id, state.options.jobs);
  const jobResults = await triggerReleaseJobs(tab.id, jobs);
  const hasReleaseFailure = jobResults.some((job) => ["failed", "missing"].includes(job.status));
  updateTask(task.id, { status: hasReleaseFailure ? "failed" : "done", message: formatJobResult(jobResults) });
  log(`发布 job 结果：${formatJobResult(jobResults)}`);
}

async function getMergeRequest(tabId, task) {
  return gitlabGet(tabId, `/api/v4/projects/${encodeURIComponent(task.projectPath)}/merge_requests/${task.mrIid}`);
}

function getMergeSkipReason(mr) {
  if (!mr) return "MR 信息为空";
  if (mr.state === "merged") return "MR 已合并，跳过";
  if (mr.state && mr.state !== "opened") return `MR 状态为 ${mr.state}，跳过`;
  if (mr.has_conflicts) return "MR 存在冲突，跳过";
  if (String(mr.detailed_merge_status || "").includes("conflict")) return `MR 合并状态为 ${mr.detailed_merge_status}，跳过`;
  if (String(mr.merge_status || "").includes("cannot_be_merged") && mr.has_conflicts !== false) return `MR 合并状态为 ${mr.merge_status}，跳过`;
  return "";
}

async function waitForMergeCommit(tabId, task) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < MERGE_TIMEOUT_MS) {
    const mr = await getMergeRequest(tabId, task);
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

async function findPipelineJobs(tabId, projectPath, pipelineId, names) {
  const jobs = await gitlabGet(
    tabId,
    `/api/v4/projects/${encodeURIComponent(projectPath)}/pipelines/${pipelineId}/jobs?per_page=100&include_retried=true`
  );

  if (!Array.isArray(jobs)) throw new Error("API 查询 pipeline jobs 失败");

  return names.map((name) => {
    const job = jobs.find((item) => item.name === name);
    return job
      ? { name, status: job.status, webUrl: job.web_url, id: job.id }
      : { name, status: "missing", webUrl: "", id: "" };
  });
}

async function triggerReleaseJobs(tabId, jobs) {
  const results = [];

  for (const job of jobs) {
    if (!job.webUrl) {
      results.push({ name: job.name, status: "missing" });
      continue;
    }

    if (job.status !== "manual") {
      results.push({ name: job.name, status: job.status });
      continue;
    }

    log(`打开 job 页面：${job.name}`);
    const tab = await navigateTab(tabId, job.webUrl);
    setTaskByTab(tab);
    await visualPause(`job 页面已打开：${job.name}`);

    const play = await runPageAction(tabId, "play", [job.name], `点击 ${job.name} 执行按钮`);
    results.push(play.ok
      ? { name: job.name, status: play.status || "played" }
      : { name: job.name, status: "failed", message: play.error || "执行按钮点击失败" });
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

  function getSourceBranch() {
    return [...document.querySelectorAll('a[href*="/-/tree/"]')]
      .map((link) => decodeURIComponent((link.href.match(/\/-\/tree\/([^?#]+)/) || [])[1] || ""))
      .find((branch) => branch && !["master", "main"].includes(branch)) || "";
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
