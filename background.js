const GITLAB_ORIGIN = "https://git.papamk.com";
const POLL_INTERVAL_MS = 3000;
const MERGE_TIMEOUT_MS = 120000;
const PIPELINE_TIMEOUT_MS = 180000;

let state = {
  running: false,
  stopRequested: false,
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
        tasks: (message.tasks || []).map((task) => ({ ...task, status: "pending", message: "等待执行" })),
        options: {
          jobs: message.options?.jobs?.length ? message.options.jobs : ["release-minor", "release-patch"],
          closeSuccessTabs: message.options?.closeSuccessTabs !== false
        }
      };
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
  notify();
}

async function processTask(task) {
  updateTask(task.id, { status: "opening_mr", message: "打开 MR 页面" });
  const tab = await createTab(task.url);

  try {
    await waitForTabComplete(tab.id);

    updateTask(task.id, { status: "merging", message: "等待合并按钮并点击" });
    const mergeResult = await sendToTab(tab.id, {
      type: "mergeMr",
      projectPath: task.projectPath,
      mrIid: task.mrIid
    });

    if (!mergeResult?.ok) {
      throw new Error(mergeResult?.error || "合并点击失败");
    }

    updateTask(task.id, { status: "reading_mr", message: "读取 merge_commit_sha" });
    const mr = await waitForMergeCommit(tab.id, task);
    updateTask(task.id, {
      mergeCommitSha: mr.merge_commit_sha,
      status: "finding_pipeline",
      message: `查找 master pipeline: ${shortSha(mr.merge_commit_sha)}`
    });

    const pipeline = await waitForPipeline(tab.id, task.projectPath, mr.merge_commit_sha);
    updateTask(task.id, {
      pipelineId: pipeline.id,
      status: "triggering_jobs",
      message: `找到 pipeline #${pipeline.id}，准备触发发布 job`
    });

    const jobResult = await triggerJobs(tab.id, task.projectPath, pipeline.id, state.options.jobs);
    updateTask(task.id, {
      status: "done",
      message: formatJobResult(jobResult)
    });

    if (state.options.closeSuccessTabs) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  } catch (error) {
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

async function triggerJobs(tabId, projectPath, pipelineId, expectedNames) {
  const jobs = await gitlabApi(
    tabId,
    "GET",
    `/api/v4/projects/${encodeProject(projectPath)}/pipelines/${pipelineId}/jobs?per_page=100&include_retried=true`
  );

  if (!Array.isArray(jobs)) {
    throw new Error("读取 pipeline jobs 失败");
  }

  const result = [];

  for (const name of expectedNames) {
    const job = jobs.find((item) => item.name === name);
    if (!job) {
      result.push({ name, status: "missing" });
      continue;
    }

    if (job.status === "manual") {
      await gitlabApi(tabId, "POST", `/api/v4/projects/${encodeProject(projectPath)}/jobs/${job.id}/play`);
      result.push({ name, status: "played" });
      continue;
    }

    result.push({ name, status: job.status });
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

function snapshot() {
  return JSON.parse(JSON.stringify(state));
}

function createTab(url) {
  return chrome.tabs.create({ url, active: false });
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

function encodeProject(projectPath) {
  return encodeURIComponent(projectPath);
}

function shortSha(sha) {
  return String(sha || "").slice(0, 8);
}

function formatJobResult(result) {
  return result.map((item) => `${item.name}: ${item.status}`).join("；");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
