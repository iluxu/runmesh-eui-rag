const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatLog = document.getElementById("chat-log");
const chatStatus = document.getElementById("chat-status");
const indexStatus = document.getElementById("index-status");
const refreshIndexBtn = document.getElementById("refresh-index");
const clearChatBtn = document.getElementById("clear-chat");
const suggestionChips = document.querySelectorAll(".suggestion-chip");

const sessionKey = "runmesh_eui_session";
const historyKey = "runmesh_eui_history";
const fallbackId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let sessionId = fallbackId;
let conversation = [];

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

if (chatForm) {
  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = chatInput.value.trim();
    if (!prompt) return;
    addMessage("user", prompt);
    conversation.push({ role: "user", content: prompt });
    saveHistory();
    chatStatus.textContent = "Working";

    const outbound = conversation.filter(
      (msg) => !(msg.role === "assistant" && msg.content === defaultGreeting.content)
    );

    const assistantMsg = addMessage("assistant", "...");
    assistantMsg.classList.add("streaming");
    let assistantText = "";

    const res = await fetch("/api/ask/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, sessionId, messages: outbound })
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
