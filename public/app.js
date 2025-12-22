const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatLog = document.getElementById("chat-log");
const chatStatus = document.getElementById("chat-status");
const indexStatus = document.getElementById("index-status");
const refreshIndexBtn = document.getElementById("refresh-index");
const clearChatBtn = document.getElementById("clear-chat");
const suggestionChips = document.querySelectorAll(".suggestion-chip");
const projectDrop = document.getElementById("project-drop");
const projectFileInput = document.getElementById("project-file");
const projectMeta = document.getElementById("project-meta");
const projectBrowse = document.getElementById("project-browse");
const projectClear = document.getElementById("project-clear");

const sessionKey = "runmesh_eui_session";
const historyKey = "runmesh_eui_history";
const fallbackId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let sessionId = fallbackId;
let conversation = [];
const MAX_PROJECT_BYTES = 4 * 1024 * 1024;
const MAX_PROJECT_CHARS = 200000;
const allowedExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".yaml",
  ".yml",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".html"
]);

let projectText = "";
let projectName = "";
let projectSize = 0;
let projectTruncated = false;

let safeStorage = null;
try {
  safeStorage = window.localStorage;
} catch {
  safeStorage = null;
}

if (safeStorage) {
  sessionId = safeStorage.getItem(sessionKey) || (crypto?.randomUUID?.() ?? fallbackId);
  try {
    safeStorage.setItem(sessionKey, sessionId);
  } catch {
    // Ignore storage failures.
  }
} else {
  sessionId = crypto?.randomUUID?.() ?? fallbackId;
}

function loadHistory() {
  if (!safeStorage) return [];
  try {
    const raw = safeStorage.getItem(historyKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && (item.role === "user" || item.role === "assistant"));
  } catch {
    return [];
  }
}

function saveHistory() {
  if (!safeStorage) return;
  try {
    safeStorage.setItem(historyKey, JSON.stringify(conversation));
  } catch {
    // Ignore storage failures.
  }
}

function formatNumber(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatBytes(value) {
  if (value < 1024) return `${formatNumber(value)} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${formatNumber(Math.round(kb))} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${formatNumber(Math.round(mb))} MB`;
  const gb = mb / 1024;
  return `${formatNumber(Math.round(gb))} GB`;
}

function setProjectMeta(text, isError = false) {
  if (!projectMeta) return;
  projectMeta.textContent = text;
  projectMeta.classList.toggle("error", isError);
}

function resetProject() {
  projectText = "";
  projectName = "";
  projectSize = 0;
  projectTruncated = false;
  setProjectMeta("No file attached.");
  if (projectDrop) {
    projectDrop.classList.remove("has-file");
    projectDrop.classList.remove("drag-active");
  }
  if (projectClear) projectClear.disabled = true;
}

function isLikelyTextFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith("text/")) return true;
  const name = file.name || "";
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = name.slice(dot).toLowerCase();
  return allowedExtensions.has(ext);
}

async function readProjectFile(file) {
  if (!file) return;
  if (!isLikelyTextFile(file)) {
    resetProject();
    setProjectMeta("Unsupported file type. Use a text file export.", true);
    return;
  }
  if (file.size > MAX_PROJECT_BYTES) {
    resetProject();
    setProjectMeta(`File too large. Max ${formatBytes(MAX_PROJECT_BYTES)}.`, true);
    return;
  }
  try {
    const text = await file.text();
    const trimmed = text.length > MAX_PROJECT_CHARS ? text.slice(0, MAX_PROJECT_CHARS) : text;
    if (!trimmed.trim()) {
      resetProject();
      setProjectMeta("File is empty.", true);
      return;
    }
    projectText = trimmed;
    projectName = file.name || "project.txt";
    projectSize = file.size;
    projectTruncated = text.length > MAX_PROJECT_CHARS;
    const note = projectTruncated
      ? `Truncated to ${formatNumber(MAX_PROJECT_CHARS)} chars.`
      : `Loaded ${formatNumber(trimmed.length)} chars.`;
    setProjectMeta(`${projectName} | ${formatBytes(projectSize)} | ${note}`);
    if (projectDrop) projectDrop.classList.add("has-file");
    if (projectClear) projectClear.disabled = false;
  } catch {
    resetProject();
    setProjectMeta("Failed to read file.", true);
  }
}

function escapeHtml(input) {
  const value = String(input ?? "");
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMarkdown(text) {
  const parts = String(text ?? "").split("```");
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        const lines = part.split("\n");
        const lang = lines[0]?.trim() ?? "";
        const code = lines.length > 1 ? lines.slice(1).join("\n") : part;
        const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
        return `<pre class="code-block"${langAttr}><code>${escapeHtml(code)}</code></pre>`;
      }

      const escaped = escapeHtml(part);
      const withInline = escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
      const withLinks = withInline.replace(
        /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g,
        '<a href="$1" target="_blank" rel="noreferrer">$1</a>'
      );
      return withLinks.replaceAll("\n", "<br />");
    })
    .join("");
}

function addMessage(role, text) {
  const msg = document.createElement("div");
  msg.className = `chat-msg ${role}`;
  msg.innerHTML = `<strong>${role === "user" ? "You" : "RunMesh"}</strong><p>${formatMarkdown(text)}</p>`;
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
  return msg;
}

function renderHistory() {
  if (!chatLog) return;
  chatLog.innerHTML = "";
  conversation.forEach((msg) => addMessage(msg.role, msg.content));
}

const defaultGreeting = {
  role: "assistant",
  content: "Ask about any EUI component, API, or quickstart step."
};

conversation = loadHistory();
if (!conversation.length) {
  conversation = [defaultGreeting];
  saveHistory();
}
renderHistory();

if (projectDrop) {
  const setDragActive = (active) => {
    projectDrop.classList.toggle("drag-active", active);
  };

  projectDrop.addEventListener("dragenter", (event) => {
    event.preventDefault();
    setDragActive(true);
  });

  projectDrop.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  });

  projectDrop.addEventListener("dragleave", () => setDragActive(false));
  projectDrop.addEventListener("dragend", () => setDragActive(false));

  projectDrop.addEventListener("drop", (event) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      readProjectFile(file);
    }
  });

  projectDrop.addEventListener("click", (event) => {
    const target = event.target;
    if (target === projectBrowse || target === projectClear) return;
    if (projectFileInput) projectFileInput.click();
  });
}

if (projectBrowse) {
  projectBrowse.addEventListener("click", () => {
    if (projectFileInput) projectFileInput.click();
  });
}

if (projectClear) {
  projectClear.addEventListener("click", () => {
    resetProject();
  });
}

if (projectFileInput) {
  projectFileInput.addEventListener("change", (event) => {
    const file = event.target?.files?.[0];
    if (file) {
      readProjectFile(file);
    }
    projectFileInput.value = "";
  });
}

if (chatForm) {
  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = chatInput.value.trim();
    if (!prompt) return;
    const projectNote = projectText
      ? `\n\n[Project attached: ${projectName || "project.txt"} (${formatBytes(projectSize)}, ${formatNumber(
          projectText.length
        )} chars${projectTruncated ? ", truncated" : ""})]`
      : "";
    const displayPrompt = `${prompt}${projectNote}`;
    addMessage("user", displayPrompt);
    conversation.push({ role: "user", content: displayPrompt });
    saveHistory();
    chatStatus.textContent = "Working";

    const outbound = conversation.filter(
      (msg) => !(msg.role === "assistant" && msg.content === defaultGreeting.content)
    );

    const assistantMsg = addMessage("assistant", "...");
    assistantMsg.classList.add("streaming");
    let assistantText = "";

    const projectPayload = projectText
      ? { name: projectName || "project.txt", text: projectText, truncated: projectTruncated }
      : undefined;

    const res = await fetch("/api/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, sessionId, messages: outbound, project: projectPayload })
    });

    if (!res.ok || !res.body || res.headers.get("content-type")?.includes("application/json")) {
      const payload = await res.json().catch(() => ({}));
      assistantMsg.classList.remove("streaming");
      const errorText = payload.error || `Request failed (${res.status})`;
      assistantMsg.querySelector("p").innerHTML = formatMarkdown(errorText);
      chatStatus.textContent = "Error";
      conversation.push({ role: "assistant", content: errorText });
      saveHistory();
      return;
    }

    chatStatus.textContent = "Streaming";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const flushText = () => {
      assistantMsg.querySelector("p").innerHTML = formatMarkdown(assistantText || "...");
      chatLog.scrollTop = chatLog.scrollHeight;
    };

    let streamDone = false;
    while (!streamDone) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const lines = part.split("\n");
        let event = "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data += line.slice(5).trim();
        }

        if (event === "token") {
          try {
            const payload = JSON.parse(data);
            if (payload.token) {
              assistantText += payload.token;
              flushText();
            }
          } catch {
            continue;
          }
        }

        if (event === "done") {
          streamDone = true;
          break;
        }
      }
    }

    assistantMsg.classList.remove("streaming");
    flushText();
    chatStatus.textContent = "Ready";
    conversation.push({ role: "assistant", content: assistantText });
    saveHistory();
  });
}

if (chatInput && chatForm) {
  chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (typeof chatForm.requestSubmit === "function") {
        chatForm.requestSubmit();
      } else {
        chatForm.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    }
  });
}

async function refreshStatus() {
  if (!indexStatus) return;
  const res = await fetch("/api/status");
  const payload = await res.json();
  if (!res.ok || payload.error) {
    indexStatus.textContent = payload.error ? `Index: Error (${payload.error})` : "Index: Error";
    return;
  }
  if (!payload.ready) {
    if (payload.state === "crawling") {
      const extra = payload.pagesCrawled ? ` (${payload.pagesCrawled} pages)` : "";
      indexStatus.textContent = `Index: Crawling${extra}`;
      return;
    }
    if (payload.state === "embedding") {
      indexStatus.textContent = "Index: Embedding";
      return;
    }
    indexStatus.textContent = payload.error ? `Index: Error (${payload.error})` : "Index: Loading";
    return;
  }
  const label = `Index: ${payload.chunks} chunks (${payload.source})`;
  indexStatus.textContent = label;
}

if (refreshIndexBtn) {
  refreshIndexBtn.addEventListener("click", async () => {
    if (!indexStatus) return;
    indexStatus.textContent = "Index: Refreshing";
    const res = await fetch("/api/refresh", { method: "POST" });
    const payload = await res.json();
    if (!res.ok || payload.error) {
      indexStatus.textContent = "Index: Error";
      return;
    }
    await refreshStatus();
  });
}

if (clearChatBtn) {
  clearChatBtn.addEventListener("click", () => {
    conversation = [defaultGreeting];
    saveHistory();
    renderHistory();
  });
}

if (suggestionChips && suggestionChips.length) {
  suggestionChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const prompt = chip.getAttribute("data-prompt") || "";
      if (!prompt || !chatInput) return;
      chatInput.value = prompt;
      chatInput.focus();
    });
  });
}

setInterval(refreshStatus, 2000);
refreshStatus();
