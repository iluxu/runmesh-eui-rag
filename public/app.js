const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatLog = document.getElementById("chat-log");
const chatStatus = document.getElementById("chat-status");
const indexStatus = document.getElementById("index-status");
const refreshIndexBtn = document.getElementById("refresh-index");
const suggestionChips = document.querySelectorAll(".suggestion-chip");

const sessionKey = "runmesh_eui_session";
const fallbackId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let sessionId = fallbackId;

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
      return withInline.replaceAll("\n", "<br />");
    })
    .join("");
}

function addMessage(role, text) {
  const msg = document.createElement("div");
  msg.className = `chat-msg ${role}`;
  msg.innerHTML = `<strong>${role === "user" ? "You" : "RunMesh"}</strong><p>${formatMarkdown(text)}</p>`;
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
}

if (chatForm) {
  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = chatInput.value.trim();
    if (!prompt) return;
    addMessage("user", prompt);
    chatStatus.textContent = "Working";

    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, sessionId })
    });
    const payload = await res.json();
    if (!res.ok || payload.error) {
      chatStatus.textContent = "Error";
      addMessage("assistant", payload.error || "Request failed");
      return;
    }
    chatStatus.textContent = "Ready";
    addMessage("assistant", payload.response || "");
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
