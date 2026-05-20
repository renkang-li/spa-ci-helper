const GITLAB_ORIGIN = "https://git.papamk.com";

const els = {
  sourceText: document.querySelector("#sourceText"),
  parseBtn: document.querySelector("#parseBtn"),
  loadSampleBtn: document.querySelector("#loadSampleBtn"),
  startBtn: document.querySelector("#startBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  releaseMinor: document.querySelector("#releaseMinor"),
  releasePatch: document.querySelector("#releasePatch"),
  closeSuccessTabs: document.querySelector("#closeSuccessTabs"),
  runState: document.querySelector("#runState"),
  summary: document.querySelector("#summary"),
  taskList: document.querySelector("#taskList")
};

let tasks = [];

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

function selectedJobs() {
  return [
    els.releaseMinor.checked ? "release-minor" : null,
    els.releasePatch.checked ? "release-patch" : null
  ].filter(Boolean);
}

function statusClass(status) {
  if (status === "done") return "done";
  if (status === "failed" || status === "stopped") return "failed";
  if (status !== "pending") return "running";
  return "";
}

function render(state = {}) {
  const allTasks = state.tasks || tasks;
  const running = state.running === true;
  const doneCount = allTasks.filter((task) => task.status === "done").length;
  const failedCount = allTasks.filter((task) => task.status === "failed").length;
  const pendingCount = allTasks.filter((task) => task.status === "pending").length;

  els.runState.textContent = running ? "running" : "idle";
  els.startBtn.disabled = allTasks.length === 0 || running;
  els.stopBtn.disabled = !running;
  els.summary.textContent = allTasks.length
    ? `共 ${allTasks.length} 个 MR，完成 ${doneCount}，失败 ${failedCount}，待执行 ${pendingCount}`
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
    project.textContent = `${task.projectPath}!${task.mrIid}`;

    const badge = document.createElement("span");
    badge.className = `badge ${statusClass(task.status)}`;
    badge.textContent = task.status;

    const message = document.createElement("div");
    message.className = "message";
    message.textContent = task.message || "";

    title.append(project, badge);
    li.append(title, message);
    els.taskList.append(li);
  }
}

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function refreshState() {
  const state = await send({ type: "getState" });
  if (state?.tasks?.length) {
    tasks = state.tasks;
    render(state);
    return;
  }
  render({ tasks, running: state?.running === true });
}

els.parseBtn.addEventListener("click", async () => {
  tasks = parseMergeRequests(els.sourceText.value);
  await chrome.storage.local.set({ draftText: els.sourceText.value });
  render({ tasks, running: false });
});

els.loadSampleBtn.addEventListener("click", () => {
  els.sourceText.value = "请在这里粘贴 you-should-know.md 里的 MR 列表。Chrome 插件无法直接读取本地文件。";
  els.sourceText.focus();
});

els.startBtn.addEventListener("click", async () => {
  const jobs = selectedJobs();
  if (!jobs.length) {
    els.summary.textContent = "至少选择一个 release job";
    return;
  }

  await send({
    type: "start",
    tasks,
    options: {
      jobs,
      closeSuccessTabs: els.closeSuccessTabs.checked
    }
  });
  await refreshState();
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
  render({ tasks, running: false });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "stateUpdated") {
    tasks = message.state.tasks || tasks;
    render(message.state);
  }
});

chrome.storage.local.get(["draftText"], async ({ draftText }) => {
  if (draftText) {
    els.sourceText.value = draftText;
    tasks = parseMergeRequests(draftText);
  }
  await refreshState();
  if (!tasks.length) render({ tasks, running: false });
});
