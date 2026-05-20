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
    closeSuccessTabs: true
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
          closeSuccessTabs: message.options?.closeSuccessTabs !== false
        }
      };
      log(`收到开始请求，共 ${state.tasks.length} 个 MR，jobs: ${state.options.jobs.join(", ")}`);
      notify();
      processQueue();
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
  log(`已创建标签页 #${tab.id}`);

  try {
    await waitForTabComplete(tab.id);

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

    const releaseJobs = await queryReleaseJobs(tab.id, task.projectPath, pipeline.id, state.options.jobs);
    log(`API 找到 release job：${formatJobResult(releaseJobs)}`);
    updateTask(task.id, {
      pipelineId: pipeline.id,
      status: "triggering_jobs",
      message: `打开 job 页面，DOM 点击执行`
    });

    const jobResult = await playJobsByDom(tab.id, releaseJobs);
    log(`发布 job 结果：${formatJobResult(jobResult)}`);
    updateTask(task.id, {
      status: "done",
      message: formatJobResult(jobResult)
    });

    if (state.options.closeSuccessTabs) {
      await chrome.tabs.remove(tab.id).catch(() => {});
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

async function queryReleaseJobs(tabId, projectPath, pipelineId, expectedNames) {
  const jobs = await gitlabApi(
    tabId,
    "GET",
    `/api/v4/projects/${encodeProject(projectPath)}/pipelines/${pipelineId}/jobs?per_page=100&include_retried=true`
  );

  if (!Array.isArray(jobs)) {
    throw new Error("API 读取 pipeline jobs 失败");
  }

  return expectedNames.map((name) => {
    const job = jobs.find((item) => item.name === name);
    if (!job) return { name, status: "missing", href: "" };

    return {
      name,
      status: job.status,
      href: job.web_url || `${GITLAB_ORIGIN}/${projectPath}/-/jobs/${job.id}`
    };
  });
}

async function playJobsByDom(tabId, jobs) {
  const result = [];

  for (const job of jobs) {
    if (!job.href) {
      result.push({ name: job.name, status: job.status || "missing" });
      continue;
    }

    if (job.status && job.status !== "manual") {
      result.push({ name: job.name, status: job.status });
      continue;
    }

    log(`打开 job 页面：${job.name}`);
    await navigateTab(tabId, job.href);

    const playResult = await sendToTab(tabId, {
      type: "playManualJob",
      jobName: job.name
    });

    if (!playResult?.ok) {
      result.push({ name: job.name, status: "failed", message: playResult?.error || "DOM 点击执行失败" });
      continue;
    }

    result.push({ name: job.name, status: playResult.status || "played" });
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
  return chrome.tabs.create({ url, active: true });
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
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url, active: true }, () => {
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
        resolve();
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
        resolve();
        return;
      }

      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function sendToTab(tabId, message) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < 15000) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  throw new Error(lastError?.message || "content script 未响应");
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
