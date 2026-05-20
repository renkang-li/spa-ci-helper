const GITLAB_ORIGIN = "https://git.papamk.com";

const els = {
  sourceText: document.querySelector("#sourceText"),
  sourceLabel: document.querySelector("#sourceLabel"),
  parseBtn: document.querySelector("#parseBtn"),
  startBtn: document.querySelector("#startBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  reloadBtn: document.querySelector("#reloadBtn"),
  modeMerge: document.querySelector("#modeMerge"),
  modeProd: document.querySelector("#modeProd"),
  releaseOptions: document.querySelector("#releaseOptions"),
  releaseMinor: document.querySelector("#releaseMinor"),
  releasePatch: document.querySelector("#releasePatch"),
  visibleExecution: document.querySelector("#visibleExecution"),
  slowMode: document.querySelector("#slowMode"),
  version: document.querySelector("#version"),
  buildInfo: document.querySelector("#buildInfo"),
  runState: document.querySelector("#runState"),
  summary: document.querySelector("#summary"),
  taskList: document.querySelector("#taskList"),
  logList: document.querySelector("#logList")
};

let tasks = [];
let logs = [];

els.version.textContent = `v${chrome.runtime.getManifest().version}`;

async function refreshBuildInfo() {
  try {
    const info = await send({ type: "getBuildInfo" });
    els.buildInfo.textContent = info?.ok
      ? `backend: v${info.version} ${info.buildId}`
      : "backend: unavailable";
  } catch (error) {
    els.buildInfo.textContent = `backend: ${error.message}`;
  }
}

function parseMergeRequests(text) {
  const pattern = /https:\/\/git\.papamk\.com\/(.+?)\/-\/merge_requests\/(\d+)/g;
  const seen = new Set();
  const result = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const projectPath = decodeURIComponent(match[1]);
    const mrIid = Number(match[2]);
    const key = `${projectPath}!${mrIid}`;

    if (seen.has(key)) continue;
    seen.add(key);

    result.push({
      id: key,
      url: `${GITLAB_ORIGIN}/${projectPath}/-/merge_requests/${mrIid}`,
      projectPath,
      mrIid,
      status: "pending",
      message: "等待执行"
    });
  }

  return result;
}

function parseProdUploads(text) {
  const seen = new Set();
  const result = [];

  for (const rawLine of text.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const urlMatch = line.match(/https:\/\/git\.papamk\.com\/([^\s)]+)/);
    const tagMatch = line.match(/\b(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
    if (!urlMatch || !tagMatch) continue;

    addProdTask(result, seen, urlMatch[1], tagMatch[1]);
  }

  if (!result.length) {
    const urls = [...text.matchAll(/https:\/\/git\.papamk\.com\/([^\s)]+)/g)];
    const tags = [...text.matchAll(/\b(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/g)];
    if (urls.length === 1 && tags.length === 1) addProdTask(result, seen, urls[0][1], tags[0][1]);
  }

  return result;
}

function addProdTask(result, seen, rawProjectPath, tagName) {
  const projectPath = normalizeProjectPath(rawProjectPath);
  const key = `${projectPath}@${tagName}`;
  if (!projectPath || seen.has(key)) return;
  seen.add(key);

  result.push({
    id: key,
    mode: "prod",
    url: `${GITLAB_ORIGIN}/${projectPath}/-/tags/${encodeURIComponent(tagName)}`,
    projectPath,
    tagName,
    jobName: "upload-prod",
    status: "pending",
    message: "等待执行"
  });
}

function normalizeProjectPath(value) {
  return decodeURIComponent(value)
    .split(/[?#]/)[0]
    .split("/-/")[0]
    .replace(/[),，。]+$/g, "")
    .replace(/\/+$/g, "")
    .replace(/\.git$/g, "");
}

function currentMode() {
  return els.modeProd.checked ? "prod" : "merge";
}

function selectedJobs() {
  return [els.releasePatch.checked ? "release-patch" : "release-minor"];
}

function taskTitle(task) {
  return task.mode === "prod" ? `${task.projectPath}@${task.tagName}` : `${task.projectPath}!${task.mrIid}`;
}

function statusClass(status) {
  if (status === "done" || status === "skipped") return "done";
  if (status === "failed" || status === "stopped") return "failed";
  if (status !== "pending") return "running";
  return "";
}

function render(state = {}) {
  const allTasks = state.tasks || tasks;
  const allLogs = state.logs || logs;
  const running = state.running === true;
  const doneCount = allTasks.filter((task) => task.status === "done").length;
  const failedCount = allTasks.filter((task) => task.status === "failed").length;
  const pendingCount = allTasks.filter((task) => task.status === "pending").length;
  const skippedCount = allTasks.filter((task) => task.status === "skipped").length;
  const taskKind = allTasks.some((task) => task.mode === "prod") ? "个生产上传任务" : "个 MR";

  els.runState.textContent = running ? "running" : "idle";
  els.startBtn.disabled = allTasks.length === 0 || running;
  els.stopBtn.disabled = !running;
  els.summary.textContent = allTasks.length
    ? `共 ${allTasks.length} ${taskKind}，完成 ${doneCount}，失败 ${failedCount}，跳过 ${skippedCount}，待执行 ${pendingCount}`
    : "尚未解析任务";

  els.taskList.innerHTML = "";
  for (const task of allTasks) {
    const li = document.createElement("li");
    li.className = "task";

    const title = document.createElement("div");
    title.className = "task-title";

    const project = document.createElement("a");
    project.className = "project";
    project.href = task.url;
    project.target = "_blank";
    project.textContent = taskTitle(task);

    const badge = document.createElement("span");
    badge.className = `badge ${statusClass(task.status)}`;
    badge.textContent = task.status;

    const message = document.createElement("div");
    message.className = "message";
    message.textContent = task.message || "";

    const meta = document.createElement("div");
    meta.className = "task-meta";

    const url = document.createElement("span");
    url.className = "task-url";
    url.title = task.currentUrl || task.url;
    url.textContent = task.tabId ? `tab #${task.tabId} ${task.currentUrl || task.url}` : "";

    meta.append(url);

    if (task.tabId) {
      const focusButton = document.createElement("button");
      focusButton.className = "mini";
      focusButton.type = "button";
      focusButton.dataset.action = "focus-tab";
      focusButton.dataset.tabId = String(task.tabId);
      focusButton.textContent = "查看";
      meta.append(focusButton);
    }

    title.append(project, badge);
    li.append(title, message);
    if (task.tabId || task.currentUrl) li.append(meta);
    els.taskList.append(li);
  }

  els.logList.innerHTML = "";
  for (const line of allLogs.slice(-80)) {
    const li = document.createElement("li");
    li.className = "log";
    li.textContent = line;
    els.logList.append(li);
  }
}

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function refreshState() {
  const state = await send({ type: "getState" });
  if (state?.tasks?.length) {
    tasks = state.tasks;
    logs = state.logs || logs;
    render(state);
    return;
  }
  logs = state?.logs || logs;
  render({ tasks, logs, running: state?.running === true });
}

function updateModeView() {
  const prodMode = currentMode() === "prod";
  els.sourceLabel.textContent = prodMode ? "粘贴项目地址和 tag" : "粘贴 MR 聊天记录";
  els.sourceText.placeholder = prodMode
    ? "https://git.papamk.com/lirenkang/test-ci-chrome v1.0.6"
    : "https://git.papamk.com/lf/minishops/.../-/merge_requests/26";
  els.releaseOptions.hidden = prodMode;
}

async function parseInput() {
  tasks = currentMode() === "prod"
    ? parseProdUploads(els.sourceText.value)
    : parseMergeRequests(els.sourceText.value);
  await chrome.storage.local.set({ draftText: els.sourceText.value, runMode: currentMode() });
  render({ tasks, running: false });
}

els.parseBtn.addEventListener("click", parseInput);

els.startBtn.addEventListener("click", async () => {
  const jobs = selectedJobs();
  if (currentMode() === "merge" && !jobs.length) {
    els.summary.textContent = "至少选择一个 release job";
    return;
  }

  logs = [`[${new Date().toLocaleTimeString()}] popup 已点击开始，发送任务到后台`];
  render({ tasks, logs, running: true });

  const response = await send({
    type: "start",
    tasks,
    options: {
      mode: currentMode(),
      jobs,
      visibleExecution: els.visibleExecution.checked,
      slowMode: els.slowMode.checked
    }
  });

  if (response?.ok === false) {
    logs = [...logs, `[${new Date().toLocaleTimeString()}] 启动失败：${response.error}`];
    render({ tasks, logs, running: false });
    return;
  }

  tasks = response.tasks || tasks;
  logs = response.logs || logs;
  render(response);
});

els.stopBtn.addEventListener("click", async () => {
  await send({ type: "stop" });
  await refreshState();
});

els.clearBtn.addEventListener("click", async () => {
  tasks = [];
  els.sourceText.value = "";
  await chrome.storage.local.remove(["draftText"]);
  await send({ type: "clear" });
  logs = [];
  render({ tasks, running: false });
});

els.reloadBtn.addEventListener("click", () => {
  chrome.runtime.reload();
});

els.taskList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action='focus-tab']");
  if (!button) return;

  await send({
    type: "focusTab",
    tabId: Number(button.dataset.tabId)
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "stateUpdated") {
    tasks = message.state.tasks || tasks;
    logs = message.state.logs || logs;
    render(message.state);
  }
});

for (const input of [els.modeMerge, els.modeProd]) {
  input.addEventListener("change", async () => {
    updateModeView();
    tasks = [];
    await chrome.storage.local.set({ runMode: currentMode() });
    render({ tasks, logs, running: false });
  });
}

chrome.storage.local.get(["draftText", "runMode"], async ({ draftText, runMode }) => {
  if (runMode === "prod") els.modeProd.checked = true;
  updateModeView();
  if (draftText) {
    els.sourceText.value = draftText;
    tasks = currentMode() === "prod" ? parseProdUploads(draftText) : parseMergeRequests(draftText);
  }
  await refreshState();
  await refreshBuildInfo();
  if (!tasks.length) render({ tasks, running: false });
});
