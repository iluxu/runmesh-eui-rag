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
const imageDrop = document.getElementById("image-drop");
const imageFilesInput = document.getElementById("image-files");
const imageMeta = document.getElementById("image-meta");
const imageBrowse = document.getElementById("image-browse");
const imageClear = document.getElementById("image-clear");

const sessionKey = "runmesh_eui_session";
const historyKey = "runmesh_eui_history";
const fallbackId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let sessionId = fallbackId;
let conversation = [];
const MAX_PROJECT_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGES = 3;
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
const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

let projectText = "";
let projectName = "";
let projectSize = 0;
let imageItems = [];

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

function setImageMeta(text, isError = false) {
  if (!imageMeta) return;
  imageMeta.textContent = text;
  imageMeta.classList.toggle("error", isError);
}

function resetProject() {
  projectText = "";
  projectName = "";
  projectSize = 0;
  setProjectMeta("No file attached.");
  if (projectDrop) {
    projectDrop.classList.remove("has-file");
    projectDrop.classList.remove("drag-active");
  }
  if (projectClear) projectClear.disabled = true;
}

function resetImages() {
  imageItems = [];
  setImageMeta("No images attached.");
  if (imageDrop) {
    imageDrop.classList.remove("has-file");
    imageDrop.classList.remove("drag-active");
  }
  if (imageClear) imageClear.disabled = true;
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

function isSupportedImage(file) {
  if (!file) return false;
  if (file.type && allowedImageTypes.has(file.type)) return true;
  const name = file.name || "";
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = name.slice(dot).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
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
    if (!text.trim()) {
      resetProject();
      setProjectMeta("File is empty.", true);
      return;
    }
    projectText = text;
    projectName = file.name || "project.txt";
    projectSize = file.size;
    const note = `Loaded ${formatNumber(text.length)} chars.`;
    setProjectMeta(`${projectName} | ${formatBytes(projectSize)} | ${note}`);
    if (projectDrop) projectDrop.classList.add("has-file");
    if (projectClear) projectClear.disabled = false;
  } catch {
    resetProject();
    setProjectMeta("Failed to read file.", true);
  }
}

function summarizeImages(items, hadOverflow) {
  const totalSize = items.reduce((sum, item) => sum + item.size, 0);
  const names = items.map((item) => item.name).slice(0, 2).join(", ");
  const extra = items.length > 2 ? ` +${items.length - 2} more` : "";
  const overflow = hadOverflow ? ` | Limited to ${MAX_IMAGES} images.` : "";
  return `${items.length} image${items.length === 1 ? "" : "s"} | ${formatBytes(totalSize)} total | ${names}${extra}${overflow}`;
}

async function addImageFiles(fileList, { append } = { append: false }) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const base = append ? imageItems.slice() : [];
  const available = MAX_IMAGES - base.length;
  if (available <= 0) {
    setImageMeta(`Already at ${MAX_IMAGES} images.`, true);
    return;
  }
  const selected = files.slice(0, available);
  const hadOverflow = files.length > available;
  const errors = [];
  const items = [];

  for (const file of selected) {
    if (!isSupportedImage(file)) {
      errors.push(`${file.name || "image"} is not supported`);
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      errors.push(`${file.name || "image"} is too large`);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
        items.push({
          name: file.name || "image",
          size: file.size,
          type: file.type || "image",
          dataUrl
        });
      } else {
        errors.push(`${file.name || "image"} could not be read`);
      }
    } catch {
      errors.push(`${file.name || "image"} could not be read`);
    }
  }

  const nextItems = base.concat(items);

  if (!nextItems.length) {
    resetImages();
    const message = errors.length
      ? `No images attached. ${errors[0]}.`
      : "No images attached.";
    setImageMeta(message, true);
    return;
  }

  imageItems = nextItems;
  setImageMeta(summarizeImages(nextItems, hadOverflow));
  if (imageDrop) imageDrop.classList.add("has-file");
  if (imageClear) imageClear.disabled = false;
  if (errors.length) {
    setImageMeta(`${summarizeImages(nextItems, hadOverflow)} | Some files were skipped.`, true);
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
        return `<pre class="code-block"${langAttr}><button type="button" class="copy-code">Copy</button><code>${escapeHtml(
          code
        )}</code></pre>`;
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

if (chatLog) {
  chatLog.addEventListener("click", async (event) => {
    const target = event.target;
    const button = target?.closest?.(".copy-code");
    if (!button) return;
    const block = button.closest(".code-block");
    const codeEl = block?.querySelector("code");
    const code = codeEl?.innerText ?? "";
    if (!code) return;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const temp = document.createElement("textarea");
        temp.value = code;
        temp.setAttribute("readonly", "true");
        temp.style.position = "absolute";
        temp.style.left = "-9999px";
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        document.body.removeChild(temp);
      }
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = "Copy";
      }, 1400);
    } catch {
      button.textContent = "Failed";
      setTimeout(() => {
        button.textContent = "Copy";
      }, 1400);
    }
  });
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

if (imageDrop) {
  const setDragActive = (active) => {
    imageDrop.classList.toggle("drag-active", active);
  };

  imageDrop.addEventListener("dragenter", (event) => {
    event.preventDefault();
    setDragActive(true);
  });

  imageDrop.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  });

  imageDrop.addEventListener("dragleave", () => setDragActive(false));
  imageDrop.addEventListener("dragend", () => setDragActive(false));

  imageDrop.addEventListener("drop", (event) => {
    event.preventDefault();
    setDragActive(false);
    const files = event.dataTransfer?.files;
    if (files && files.length) {
      addImageFiles(files, { append: false });
    }
  });

  imageDrop.addEventListener("click", (event) => {
    const target = event.target;
    if (target === imageBrowse || target === imageClear) return;
    if (imageFilesInput) imageFilesInput.click();
  });
}

if (imageBrowse) {
  imageBrowse.addEventListener("click", () => {
    if (imageFilesInput) imageFilesInput.click();
  });
}

if (imageClear) {
  imageClear.addEventListener("click", () => {
    resetImages();
  });
}

if (imageFilesInput) {
  imageFilesInput.addEventListener("change", (event) => {
    const files = event.target?.files;
    if (files && files.length) {
      addImageFiles(files, { append: false });
    }
    imageFilesInput.value = "";
  });
}

function extractClipboardImages(event) {
  const items = event.clipboardData?.items ? Array.from(event.clipboardData.items) : [];
  if (!items.length) return [];
  const files = [];
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

document.addEventListener("paste", (event) => {
  const files = extractClipboardImages(event);
  if (!files.length) return;
  addImageFiles(files, { append: true });
});

if (chatForm) {
  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = chatInput.value.trim();
    if (!prompt) return;
    const projectNote = projectText
      ? `\n\n[Project attached: ${projectName || "project.txt"} (${formatBytes(projectSize)}, ${formatNumber(
          projectText.length
        )} chars)]`
      : "";
    const imageNote = imageItems.length ? `\n\n[Images attached: ${imageItems.length}]` : "";
    const displayPrompt = `${prompt}${projectNote}${imageNote}`;
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

    const projectPayload = projectText ? { name: projectName || "project.txt", text: projectText } : undefined;
    const imagePayload = imageItems.length
      ? imageItems.map((item) => ({
          name: item.name,
          type: item.type,
          dataUrl: item.dataUrl
        }))
      : undefined;

    const res = await fetch("/api/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, sessionId, messages: outbound, project: projectPayload, images: imagePayload })
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
