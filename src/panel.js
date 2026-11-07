import { extractRoom, searchRoom } from "./extract.js";

const DEFAULT_BUTTONS = `Unread | unread | Summarize what I missed {period}: main topics, decisions, open questions and anything that needs my attention.
Day | 1d | Summarize this room's discussion {period}: main topics, decisions, open questions and action items.
Week | 7d | Summarize this room's discussion {period}: main topics, decisions, open questions and action items.
Month | 30d | Summarize this room's discussion {period}: main topics, decisions, open questions and action items.
Mentions | 7d mentions | Which of these messages {period} ask me something, request something from me or need my reply? List each, newest first, with its reference and one line on what is needed. If none do, say so.`;

const DEFAULTS = {
  baseUrl: "http://localhost:11434",
  numCtx: 16384,
  maxMsgs: 200,
  model: "",
  modelPinned: false,
  useCtx: true,
  useTools: true,
  buttons: DEFAULT_BUTTONS,
};

// Benchmarked on a Ryzen AI 9 iGPU: MoE 26b-a4b is ~2.5x faster than dense 12b at equal recall/tool-use quality
const PREFERRED_MODELS = ["gemma4:26b-a4b-it-qat", "gemma4:e4b-it-qat"];

const MAX_WINDOW_MSGS = 5000;
const PART_TTL = 60 * 86400000;
const REF_GROUP = /\[#\d+(?:\s*[-–,]\s*#?\d+)*\]/g;

const $ = (id) => document.getElementById(id);
const el = { model: $("model"), log: $("log"), input: $("input"), send: $("send"), info: $("ctx-info"), grant: $("grant") };

let cfg = { ...DEFAULTS };
let abort = null;
let modelMax = 0;
let roomReady = false;
// Element moves its read marker seconds after a room is shown, so keep where
// it was when the panel first saw the room
let seen = null;
// One chat per room, kept in chrome.storage.session (memory only): what the
// model saw, what the log shows, and the [#N] refs both of them use
let chat = newChat(null);
let switchLater = false;
// tokens Ollama read when it dropped part of a request in the current answer
let cutAt = 0;
const entries = new WeakMap();

function newChat(roomId) {
  return { roomId, history: [], log: [], refs: new Map(), refsByNum: new Map(), next: 1, urls: new Set() };
}

async function loadCfg() {
  cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $("base-url").value = cfg.baseUrl;
  $("num-ctx").value = cfg.numCtx;
  $("max-msgs").value = cfg.maxMsgs;
  $("use-ctx").checked = cfg.useCtx;
  $("use-tools").checked = cfg.useTools;
  $("buttons").value = cfg.buttons;
}

function save(patch) {
  Object.assign(cfg, patch);
  chrome.storage.local.set(patch);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatTime(ts) {
  return new Date(ts).toLocaleString("sv-SE").slice(0, 16);
}

function registerRefs(room) {
  if (!/^![^\s/?#]+$/.test(room.roomId ?? "")) return;
  for (const m of room.messages) {
    if (!/^\$[^\s/?#]+$/.test(m.id ?? "")) continue;
    let r = chat.refs.get(m.id);
    if (!r) {
      r = { n: chat.next++, id: m.id, url: `${room.base}#/room/${room.roomId}/${m.id}`, sender: m.sender, ts: m.ts };
      chat.refs.set(m.id, r);
      chat.refsByNum.set(r.n, r);
    }
    m.ref = r.n;
  }
  const inWindow = new Set(room.messages.map((m) => m.id));
  for (const m of room.messages) {
    if (m.replyTo) m.replyRef = inWindow.has(m.replyTo) ? chat.refs.get(m.replyTo)?.n : undefined;
    noteUrls(m.body);
  }
}

// fetch_url only opens links the user wrote, the room's messages hold or a
// search returned. Room text can tell the model to fetch a URL it builds
// itself, with the room's messages in it.
function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function noteUrls(text) {
  for (const raw of text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? []) {
    for (const u of [raw, raw.replace(/[.,;:!?)\]}*_]+$/, "")]) {
      const n = normUrl(u);
      if (n) chat.urls.add(n);
    }
  }
}

function linkRefs(html) {
  return html.replace(REF_GROUP, (group) =>
    group.replace(/#?(\d+)/g, (m, n) => {
      const r = chat.refsByNum.get(Number(n));
      if (!r) return m;
      const title = escapeHtml(`${r.sender}, ${formatTime(r.ts)}`);
      return `<a href="${escapeHtml(r.url)}" data-ref="${r.n}" title="${title}" target="_blank" rel="noopener">#${r.n}</a>`;
    }),
  );
}

// Cached part summaries outlive the panel's [#N] numbering, so they store event ids
function refsToIds(text) {
  return text.replace(REF_GROUP, (group) =>
    group.replace(/#?(\d+)/g, (m, n) => (chat.refsByNum.has(Number(n)) ? `#{${chat.refsByNum.get(Number(n)).id}}` : m)),
  );
}

function idsToRefs(text) {
  return text.replace(/#\{([^}]+)\}/g, (m, id) => (chat.refs.has(id) ? `#${chat.refs.get(id).n}` : "#?"));
}

function toMarkdown(text) {
  return text.replace(REF_GROUP, (group) =>
    group.slice(1, -1).replace(/#?(\d+)/g, (m, n) => {
      const r = chat.refsByNum.get(Number(n));
      return r ? `[#${r.n}](${r.url})` : m;
    }),
  );
}

function inlineMarkdown(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, "$1<i>$2</i>");
}

// Escaped first, so only the tags added here exist. Links the model writes stay
// plain text: a click on one would send whatever the model put in the URL.
function renderMarkdown(text) {
  const blocks = [];
  const src = escapeHtml(text).replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_, code) => `\0${blocks.push(code) - 1}\0`);
  const out = [];
  let para = [];
  const lists = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
    para = [];
  };
  const closeLists = (indent = -1) => {
    while (lists.length && lists.at(-1).indent > indent) out.push(`</li></${lists.pop().tag}>`);
  };
  for (const line of src.split("\n")) {
    const item = line.match(/^(\s*)(?:[*+-]|(\d+)[.)])\s+(.*)$/);
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line) || /^\s*\0\d+\0\s*$/.test(line) || /^#{1,6}\s/.test(line)) {
      flush();
      closeLists();
      if (line.includes("\0")) out.push(line.trim());
      else if (line.startsWith("#")) out.push(`<div class="h">${inlineMarkdown(line.replace(/^#+\s+/, ""))}</div>`);
      else out.push("<hr>");
    } else if (item) {
      flush();
      const indent = item[1].replace(/\t/g, "    ").length;
      const tag = item[2] ? "ol" : "ul";
      closeLists(indent);
      const top = lists.at(-1);
      if (top?.indent === indent && top.tag === tag) {
        out.push("</li>");
      } else {
        if (top?.indent === indent) out.push(`</li></${lists.pop().tag}>`);
        out.push(tag === "ol" ? `<ol start="${item[2]}">` : "<ul>");
        lists.push({ tag, indent });
      }
      out.push(`<li>${inlineMarkdown(item[3])}`);
    } else if (!line.trim()) {
      flush();
    } else if (lists.length && /^\s/.test(line)) {
      out.push(`<br>${inlineMarkdown(line.trim())}`);
    } else {
      closeLists();
      para.push(inlineMarkdown(line));
    }
  }
  flush();
  closeLists();
  const html = out.join("").replace(/\0(\d+)\0/g, (_, i) => `<pre><code>${blocks[i]}</code></pre>`);
  return linkRefs(html);
}

function renderEntry(entry) {
  const div = document.createElement("div");
  div.className = `msg ${entry.role}`;
  entries.set(div, entry);
  setText(div, entry.text);
  if (entry.stats) renderStats(div, entry);
  return div;
}

function setText(div, text) {
  const entry = entries.get(div);
  entry.text = text;
  if (entry.role === "assistant") div.innerHTML = renderMarkdown(text);
  else div.textContent = text;
}

function addMsg(role, text) {
  const entry = { role, text };
  chat.log.push(entry);
  const div = renderEntry(entry);
  el.log.append(div);
  el.log.scrollTop = el.log.scrollHeight;
  return div;
}

// shown, but not kept with the room's chat
function notice(text, role = "error") {
  const div = renderEntry({ role, text });
  el.log.append(div);
  el.log.scrollTop = el.log.scrollHeight;
  return div;
}

function saveChat() {
  if (!chat.roomId) return;
  const key = `chat:${chat.roomId}`;
  if (!chat.log.length) return chrome.storage.session.remove(key);
  // keep only refs the chat mentions; a month window registers thousands
  const cited = new Set();
  for (const text of [...chat.log.map((e) => e.text), ...chat.history.map((m) => m.content ?? "")]) {
    for (const group of text.match(REF_GROUP) ?? []) for (const n of group.match(/\d+/g)) cited.add(Number(n));
  }
  const value = {
    history: chat.history,
    log: chat.log,
    refs: [...chat.refs.values()].filter((r) => cited.has(r.n)),
    next: chat.next,
    urls: [...chat.urls],
  };
  chrome.storage.session.set({ [key]: value }).catch(async () => {
    // over the session quota: drop the other rooms' chats
    const all = await chrome.storage.session.get(null);
    await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith("chat:") && k !== key));
    chrome.storage.session.set({ [key]: value }).catch(() => {});
  });
}

async function switchChat(roomId) {
  const key = `chat:${roomId}`;
  const saved = (await chrome.storage.session.get(key))[key];
  if (chat.roomId === roomId) return;
  // an answer in progress belongs to the chat on screen; switch when it ends
  if (abort) {
    switchLater = true;
    return;
  }
  saveChat();
  chat = newChat(roomId);
  if (saved) {
    Object.assign(chat, { history: saved.history, log: saved.log, next: saved.next, urls: new Set(saved.urls) });
    for (const r of saved.refs) {
      chat.refs.set(r.id, r);
      chat.refsByNum.set(r.n, r);
    }
  }
  el.log.replaceChildren(...chat.log.map(renderEntry));
  el.log.scrollTop = el.log.scrollHeight;
}

function effectiveCtx() {
  return modelMax ? Math.min(cfg.numCtx, modelMax) : cfg.numCtx;
}

async function loadModelLimit() {
  modelMax = 0;
  $("ctx-max").textContent = "";
  $("num-ctx").removeAttribute("max");
  if (!el.model.value) return;
  try {
    const res = await fetch(`${cfg.baseUrl}/api/show`, { method: "POST", body: JSON.stringify({ model: el.model.value }) });
    if (!res.ok) return;
    const info = (await res.json()).model_info ?? {};
    const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
    if (key && Number(info[key]) > 0) {
      modelMax = Number(info[key]);
      $("ctx-max").textContent = `(model max ${modelMax})`;
      $("num-ctx").max = modelMax;
    }
  } catch {
    // limit is advisory; keep the configured value
  }
}

async function loadModels() {
  el.model.replaceChildren();
  try {
    const res = await fetch(`${cfg.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models } = await res.json();
    for (const m of models) el.model.add(new Option(m.name, m.name));
    if (!models.length) throw new Error("no models pulled");
    const names = models.map((m) => m.name);
    const pinned = cfg.modelPinned && names.includes(cfg.model);
    el.model.value = pinned
      ? cfg.model
      : PREFERRED_MODELS.find((n) => names.includes(n)) ?? (names.includes(cfg.model) ? cfg.model : names[0]);
    save({ model: el.model.value });
    await loadModelLimit();
  } catch (e) {
    notice(`Cannot list models from ${cfg.baseUrl}: ${e.message}. Is Ollama running with OLLAMA_ORIGINS=${location.origin} ?`);
  }
}

async function activeTab() {
  // ?tab=<id> lets the panel run as a normal tab (testing) and target another tab
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  if (forced) return chrome.tabs.get(forced);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function runInTab(func, args) {
  const tab = await activeTab();
  if (!tab?.id || !/^https?:/.test(tab.url ?? "")) return { error: "no-tab" };
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func, args });
    const out = res?.result ?? { error: "empty" };
    if (!out.error) {
      const u = new URL(tab.url);
      out.base = u.origin + u.pathname + u.search;
    }
    return out;
  } catch (e) {
    return { error: "inject", origin: new URL(tab.url).origin, message: String(e.message ?? e) };
  }
}

// callers register refs once they know the room is the chat's
function getRoom(limit, since = 0) {
  return runInTab(extractRoom, [limit, since]);
}

async function refreshInfo() {
  const r = await getRoom(1);
  el.grant.hidden = r.error !== "inject";
  el.grant.dataset.origin = r.origin ?? "";
  roomReady = !r.error;
  for (const b of [...$("quick").children, $("search")]) b.disabled = !roomReady;
  if (roomReady && r.roomId !== seen?.roomId) seen = { roomId: r.roomId, readTs: r.readTs };
  if (roomReady && r.roomId !== chat.roomId) await switchChat(r.roomId);
  if (r.error === "inject") el.info.textContent = `no access to ${r.origin}`;
  else if (r.error === "no-client") el.info.textContent = "not an Element tab (no Matrix client)";
  else if (r.error === "no-room") el.info.textContent = "open a room";
  else if (r.error) el.info.textContent = r.error;
  else el.info.textContent = `${r.name} (${r.memberCount ?? "?"} members)`;
}

function replyMarker(m) {
  if (!m.replyTo) return "";
  const who = m.replyToSender;
  const target = m.replyRef ? `[#${m.replyRef}]${who ? ` ${who}` : ""}` : who ? `an earlier message by ${who}` : "an earlier message";
  return ` (replying to ${target})`;
}

function formatMsg(m) {
  return `${m.ref ? `[#${m.ref}] ` : ""}[${formatTime(m.ts)}] ${m.sender}${replyMarker(m)}: ${m.body}`;
}

function toolSentence(names) {
  const web = names.filter((n) => n === "web_search" || n === "fetch_url");
  const parts = [
    ...(web.length ? [`use ${web.join("/")} for current or external facts`] : []),
    ...(names.includes("get_older_messages") ? ["get_older_messages for earlier room history"] : []),
    ...(names.includes("search_room") ? ["search_room to find messages on a topic anywhere in the room's history"] : []),
  ];
  const list = parts.length > 2 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join(" and ");
  return parts.length ? ` You have tools: ${list}, only when needed.` : "";
}

function systemPrompt(room, toolNames) {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const base =
    `The current local date and time is ${formatTime(now)} (${weekday}, timezone ${tz}). Message timestamps use the same timezone. ` +
    `When the user says "today", they mean only messages dated ${formatTime(now).slice(0, 10)}; ignore messages from other dates, and say so if there are none. ` +
    "You are Igor, an assistant living in a sidebar next to the Element (Matrix) chat client. " +
    "Answer questions about the conversation in the current room and help the user think about it. " +
    "Be concise. If the answer is not in the provided messages, say so instead of guessing. " +
    "Each room message starts with a reference like [#12]. When you summarize or point to parts of the discussion, cite the relevant messages with these references, e.g. [#12] or [#12-#20], so the user can jump to them. Only cite references that appear in the messages. " +
    "A message written as 'Name (replying to [#M] Other)' is a reply to message [#M]; what it says is about or answers that message, and any first-person statement in it belongs to the replier." +
    (toolNames ? toolSentence(toolNames) : "");
  if (!room || room.error) return base;
  const header =
    `${base}\n\nThe user is "${room.me}". Current room: "${room.name}"` + (room.topic ? ` (topic: ${room.topic})` : "");
  const kind = room.mentionsOnly
    ? "messages addressed to the user (they mention the user, reply to them, or are in a direct chat)"
    : "messages";
  if (room.parts) {
    return (
      `${header}.\nThe ${room.messages.length} ${kind} since ${formatTime(room.since)} do not fit at once, so here are ` +
      `notes on consecutive parts, oldest first, each answering the request for that part only:\n\n${room.parts.join("\n\n")}`
    );
  }
  const lines = fitLines(room.messages, roomBudget());
  // say outright that a window is complete; left to compare timestamps, models report it as empty
  const what =
    room.since && lines.length === room.messages.length
      ? `All ${lines.length} ${kind} since ${formatTime(room.since)}, the whole requested period`
      : `Most recent ${lines.length} ${kind}`;
  return `${header}.\n${what}, oldest first:\n\n${lines.join("\n")}`;
}

// room messages get ~60% of the window; gemma4 measured 2.4-2.9 characters per token on chat lines
function roomBudget() {
  return Math.floor(effectiveCtx() * 2.5 * 0.6);
}

// the newest messages that fit, formatted, oldest first
function fitLines(messages, budget) {
  const lines = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const line = formatMsg(messages[i]);
    if (used + line.length > budget) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines;
}

function weekStart(m) {
  const d = new Date(m.ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function runsBy(messages, key) {
  const runs = [];
  let last;
  for (const m of messages) {
    const k = key(m);
    if (!runs.length || k !== last) runs.push([]);
    runs.at(-1).push(m);
    last = k;
  }
  return runs;
}

// Calendar weeks, then days, then runs that fit: older parts keep the same
// messages from one run to the next, so their summaries can be cached.
function splitParts(messages, budget) {
  const size = (ms) => ms.reduce((n, m) => n + formatMsg(m).length, 0);
  const keys = [weekStart, (m) => formatTime(m.ts).slice(0, 10)];
  const split = (ms, level) => {
    if (size(ms) <= budget) return [ms];
    if (level < keys.length) return runsBy(ms, keys[level]).flatMap((run) => split(run, level + 1));
    const out = [[]];
    let used = 0;
    for (const m of ms) {
      const len = formatMsg(m).length;
      if (used + len > budget && out.at(-1).length) {
        out.push([]);
        used = 0;
      }
      out.at(-1).push(m);
      used += len;
    }
    return out;
  };
  return split(messages, 0);
}

async function partKey(request, part) {
  const data = new TextEncoder().encode([el.model.value, request, ...part.map((m) => m.id)].join("\n"));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return `part:${[...hash].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// Map step for windows larger than the context: answer the request for each
// part separately; the final answer is then built from the part notes.
async function summarizeParts(room, task, status) {
  const budget = roomBudget();
  const chunks = splitParts(room.messages, budget);
  if (chunks.length < 2) return null;
  // shorter notes as parts multiply so they all fit the final prompt; fixed steps keep cache keys stable
  const words = [200, 150, 100, 60, 40].find((w) => w * 7 * chunks.length <= budget) ?? 40;
  const parts = [];
  let cached = 0;
  for (const [i, part] of chunks.entries()) {
    const period = `${formatTime(part[0].ts)} to ${formatTime(part.at(-1).ts)}`;
    const request =
      `These ${part.length} messages (${period}) are one part of a longer period. Answer the request below for this part only, ` +
      `as bullet points in at most ${words} words, citing messages. If nothing here is relevant, reply "Nothing relevant."\n\n` +
      `Request: ${task}`;
    const key = await partKey(request, part);
    const hit = (await chrome.storage.local.get(key))[key];
    let text;
    if (hit) {
      text = idsToRefs(hit.text);
      cached++;
      chrome.storage.local.set({ [key]: { ...hit, at: Date.now() } });
    } else {
      setText(status, `${room.messages.length} messages in ${chunks.length} parts: working on part ${i + 1} (${period})…`);
      const result = await streamChat(
        [
          { role: "system", content: systemPrompt({ ...room, messages: part, since: 0, parts: null }, null) },
          { role: "user", content: request },
        ],
        null,
        () => {},
      );
      text = result.content.trim();
      if (text && !result.cut) chrome.storage.local.set({ [key]: { text: refsToIds(text), at: Date.now() } });
    }
    parts.push(`Part ${i + 1} (${period}):\n${text}`);
  }
  setText(status, `${room.messages.length} messages in ${chunks.length} parts${cached ? `, ${cached} reused from cache` : ""}`);
  if (parts.join("\n\n").length > budget) {
    addMsg("error", "The part notes do not fit the context window, so the start of the period may be cut off. Raise it in Settings.");
  }
  return parts;
}

async function prunePartCache() {
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith("part:") && !(all[k]?.at > Date.now() - PART_TTL));
  if (old.length) await chrome.storage.local.remove(old);
}

const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_OUTPUT = 8000;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web. Returns titles, URLs and snippets of the top results.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a web page and return its text content (truncated).",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute http(s) URL" } },
        required: ["url"],
      },
    },
  },
];

function parseHtml(html) {
  // inline on* handlers in fetched pages trip the extension CSP even in an inert DOMParser document
  const clean = html.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return new DOMParser().parseFromString(clean, "text/html");
}

// without it the model answers from the snippets and almost never opens a page
const SNIPPET_NOTE =
  "These are only snippets. If they do not state the answer, open the most relevant result with fetch_url before answering.";

async function webSearch(query) {
  const res = await fetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`search blocked or failed (HTTP ${res.status})`);
  const doc = parseHtml(await res.text());
  const results = [...doc.querySelectorAll(".snippet[data-type=web]")].slice(0, 6).map((r) => {
    const title = (r.querySelector(".title") ?? r.querySelector("a"))?.textContent.trim();
    const desc = r.querySelector(".content, .snippet-description, .generic-snippet")?.textContent.trim() ?? "";
    const href = r.querySelector("a")?.href;
    noteUrls(href ?? "");
    return `${title}\n${href}\n${desc}`;
  });
  if (!results.length) throw new Error("search returned no parseable results (possible bot check)");
  return `${results.join("\n\n")}\n\n${SNIPPET_NOTE}`;
}

async function fetchUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("url must be http(s)");
  // no cookies: a planted link must not act as the user on sites they are logged in to
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("html")) {
    const doc = parseHtml(text);
    doc.querySelectorAll("script,style,noscript,nav,footer,svg").forEach((n) => n.remove());
    text = doc.body?.textContent ?? "";
  }
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TOOL_OUTPUT);
}

const OLDER_TOOL = {
  type: "function",
  function: {
    name: "get_older_messages",
    description:
      "Back-paginate the current Element room and return messages older than those already in your context. Use when the user asks about earlier discussion you cannot see.",
    parameters: {
      type: "object",
      properties: { count: { type: "number", description: "How many older messages (max 100)" } },
      required: ["count"],
    },
  },
};

const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "search_room",
    description:
      "Search the whole history of the current Element room for messages containing all the given words. Use when the user asks about something that may have been discussed before the messages you can see. Use one to three distinctive words; try synonyms or other languages in separate searches.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Words that must all appear in a message" } },
      required: ["query"],
    },
  },
};

const SEARCH_HITS = 20;

async function getOlderMessages(ctx, count) {
  const n = Math.min(Math.max(Math.floor(count) || 50, 1), 100);
  const r = await getRoom(ctx.skip + n);
  if (r.error) throw new Error(r.error);
  if (r.roomId !== ctx.room.roomId) throw new Error("the open room changed");
  registerRefs(r);
  const older = r.messages.slice(0, Math.max(0, r.messages.length - ctx.skip));
  ctx.skip += older.length;
  return older.length ? older.map(formatMsg).join("\n") : "No older messages.";
}

// The result always says how far back it looked; without that, models read
// "no matches" as "never discussed".
async function findMessages(roomId, query) {
  const q = query.trim();
  if (!q) throw new Error("query is empty");
  const r = await runInTab(searchRoom, [roomId, q, SEARCH_HITS]);
  if (r.error) throw new Error(r.error);
  registerRefs(r);
  const lines = fitLines(r.messages, MAX_TOOL_OUTPUT);
  const scope = r.capped
    ? `since ${formatTime(r.back)} (older history was not searched)`
    : "in the room's whole history";
  if (!lines.length) return `No messages ${scope} contain all of: ${q}. Try other or fewer words.`;
  const head =
    r.more || lines.length < r.messages.length
      ? `The newest ${lines.length} messages containing all of: ${q} (older ones may exist; narrow the words to find them)`
      : `${lines.length === 1 ? "The only message" : `All ${lines.length} messages`} ${scope} containing all of: ${q}`;
  return `${head}. Oldest first:\n${lines.join("\n")}`;
}

async function runTool(name, args, ctx) {
  if (name === "web_search") return webSearch(String(args?.query ?? ""));
  if (name === "fetch_url") {
    const url = String(args?.url ?? "");
    if (!chat.urls.has(normUrl(url))) {
      addMsg("error", `Did not open ${url}: only links from your messages, the room or search results can be fetched.`);
      throw new Error("this link does not appear in the user's messages, the room or search results, so it cannot be fetched; ask the user for the link");
    }
    return fetchUrl(url);
  }
  if (name === "get_older_messages" && ctx.room) return getOlderMessages(ctx, Number(args?.count));
  if (name === "search_room" && ctx.room) return findMessages(ctx.room.roomId, String(args?.query ?? ""));
  throw new Error(`unknown tool ${name}`);
}

async function streamChat(messages, tools, onText) {
  const res = await fetch(`${cfg.baseUrl}/api/chat`, {
    method: "POST",
    signal: abort.signal,
    body: JSON.stringify({
      model: el.model.value,
      stream: true,
      think: false,
      // sampled answers differ run to run, sometimes wrongly; the benchmarks also use 0
      options: { num_ctx: effectiveCtx(), temperature: 0 },
      messages,
      ...(tools && { tools }),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`HTTP ${res.status}: ${body}`);
    err.noTools = /does not support tools/i.test(body);
    throw err;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  const toolCalls = [];
  // An oversized request gets no error: Ollama keeps only its end, and its token
  // count falls far below the size sent (chat text runs 2.4-2.9 chars per token).
  const sent = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const p of parts) {
      if (!p.trim()) continue;
      const chunk = JSON.parse(p);
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.message?.content) {
        content += chunk.message.content;
        onText(content);
      }
      if (chunk.message?.tool_calls) toolCalls.push(...chunk.message.tool_calls);
      if (chunk.done && chunk.prompt_eval_count && sent / chunk.prompt_eval_count > 6) {
        cut = true;
        cutAt ||= chunk.prompt_eval_count;
      }
    }
  }
  return { content, toolCalls, cut };
}

function addStats(div, t0, firstAt, model) {
  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const entry = entries.get(div);
  entry.stats = `${model ? `${model} · ` : ""}${firstAt === null ? "" : `first token ${secs(firstAt - t0)} · `}total ${secs(performance.now() - t0)}`;
  renderStats(div, entry);
}

function renderStats(div, entry) {
  const stats = document.createElement("div");
  stats.className = "stats";
  stats.textContent = entry.stats;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = "Copy";
  copy.title = "Copy as Markdown with message links";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(entry.text));
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy failed";
    }
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  });
  stats.append(copy);
  div.append(stats);
}

// opts come from quick buttons: since = window start, mentions = only messages
// addressed to the user, task = the request for the map step, roomId = room
// the window was computed for. Any opts make room context mandatory.
async function ask(text, opts = null) {
  const t0 = performance.now();
  const model = el.model.value;
  let firstAt = null;
  let lastOut = null;
  cutAt = 0;
  // Clear may swap the chat mid-answer; the rest of this answer stays with the old one
  const { history } = chat;
  const shown = addMsg("user", text);
  noteUrls(text);
  const question = { role: "user", content: text };
  history.push(question);
  abort = new AbortController();
  el.send.textContent = "Stop";

  try {
    let room = null;
    let status = null;
    if (opts || cfg.useCtx) {
      if (opts?.since) status = addMsg("tool", `loading messages since ${formatTime(opts.since)}…`);
      room = await getRoom(opts?.since ? MAX_WINDOW_MSGS : cfg.maxMsgs, opts?.since ?? 0);
      if (room.error && opts) {
        history.pop();
        addMsg("error", `Needs the open room (${room.error}).`);
        return;
      }
      if (room.error) {
        addMsg("error", `No room context (${room.error}); answering without it.`);
      } else if (room.roomId !== chat.roomId || (opts?.roomId && room.roomId !== opts.roomId)) {
        // the tab moved to another room before the panel noticed
        history.pop();
        addMsg("error", "The open room changed; ask again.");
        switchLater = true;
        return;
      } else {
        registerRefs(room);
      }
    }

    const ctx = { room: room && !room.error ? room : null, skip: room?.messages?.length ?? 0 };
    if (opts && ctx.room) {
      const r = ctx.room;
      const first = r.messages[0];
      const since = opts.since ? ` since ${formatTime(opts.since)}` : "";
      if (opts.mentions) {
        r.messages = r.messages.filter((m) => m.toMe);
        r.mentionsOnly = true;
      }
      if (opts.since) {
        r.since = opts.since;
        setText(status, `${r.messages.length} messages${opts.mentions ? " addressed to you" : ""}${since}`);
      }
      if (!r.messages.length) {
        const reply =
          !first && r.truncated
            ? `Could not load the messages${since}.`
            : opts.mentions
              ? `No messages${since} mention you or reply to you.`
              : `No messages in this room${since}.`;
        addMsg("assistant", reply);
        history.push({ role: "assistant", content: reply });
        return;
      }
      if (r.truncated) addMsg("error", `Could not load the whole period; this covers messages from ${formatTime(first.ts)} on.`);
      // a count in the request itself; given only timestamps, models now and then report a window as empty
      if (opts.since) {
        question.content += ` There are ${r.messages.length} messages${opts.mentions ? " addressed to me" : ""} in this period.`;
        setText(shown, question.content);
      }
      if (opts.since) r.parts = await summarizeParts(r, opts.task, status);
    }
    const tools = opts?.since ? [] : [...(cfg.useTools ? TOOLS : []), ...(ctx.room ? [OLDER_TOOL, SEARCH_TOOL] : [])];
    let useTools = tools.length > 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let out = null;
      const onText = (t) => {
        firstAt ??= performance.now();
        out ??= addMsg("assistant", "");
        lastOut = out;
        setText(out, t);
        el.log.scrollTop = el.log.scrollHeight;
      };
      let result;
      try {
        result = await streamChat(
          [{ role: "system", content: systemPrompt(room, useTools ? tools.map((t) => t.function.name) : null) }, ...history],
          useTools ? tools : null,
          onText,
        );
      } catch (e) {
        if (e.noTools && useTools) {
          useTools = false;
          addMsg("error", "This model has no tool support; continuing without web tools.");
          round--;
          continue;
        }
        throw e;
      }

      const msg = { role: "assistant", content: result.content };
      if (result.toolCalls.length) msg.tool_calls = result.toolCalls;
      if (result.content || result.toolCalls.length) history.push(msg);
      if (!result.toolCalls.length) return;

      for (const call of result.toolCalls) {
        const { name, arguments: args } = call.function;
        addMsg("tool", `${name}(${JSON.stringify(args)})`);
        let content;
        try {
          content = await runTool(name, args, ctx);
        } catch (e) {
          content = `Error: ${e.message}`;
        }
        history.push({ role: "tool", tool_name: name, content });
      }
    }
    addMsg("error", `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer.`);
  } catch (e) {
    if (e.name !== "AbortError") addMsg("error", `Request failed: ${e.message}`);
  } finally {
    if (lastOut) addStats(lastOut, t0, firstAt, model);
    if (cutAt) {
      addMsg(
        "error",
        `Ollama read only ${cutAt} tokens of this request: the rest did not fit the ${effectiveCtx()}-token context window and was dropped, so this answer may miss messages. Clear the chat, or raise the context window in Settings.`,
      );
    }
    finish();
  }
}

function finish() {
  abort = null;
  el.send.textContent = "Send";
  saveChat();
  if (switchLater) {
    switchLater = false;
    refreshInfo();
  }
}

// Search without the model; the results join the chat so follow-up questions can use them
async function searchInput() {
  const q = el.input.value.trim();
  if (!q || abort || !roomReady) return;
  el.input.value = "";
  const t0 = performance.now();
  const { history } = chat;
  addMsg("user", `Search: ${q}`);
  noteUrls(q);
  abort = new AbortController();
  el.send.textContent = "Stop";
  const status = notice("searching…", "tool");
  try {
    const text = await findMessages(chat.roomId, q);
    if (abort.signal.aborted) return;
    addStats(addMsg("assistant", text), t0, null);
    history.push({ role: "user", content: `Search this room for messages containing: ${q}` }, { role: "assistant", content: text });
  } catch (e) {
    addMsg("error", `Search failed: ${e.message}`);
  } finally {
    status.remove();
    finish();
  }
}

// One button per line: label | period | prompt. Period words: Nd (days),
// unread (since the read marker), mentions (only messages addressed to the user).
function parseButtons(text) {
  const buttons = [];
  const bad = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [label, period = "", ...rest] = line.split("|").map((s) => s.trim());
    const prompt = rest.join("|");
    const words = period.toLowerCase().split(/\s+/).filter(Boolean);
    if (!label || !prompt || words.some((w) => !/^(?:\d+d|unread|mentions)$/.test(w))) {
      bad.push(label || line.trim());
      continue;
    }
    const days = Number(words.find((w) => /^\d+d$/.test(w))?.slice(0, -1) ?? 0);
    buttons.push({ label, prompt, days, unread: words.includes("unread"), mentions: words.includes("mentions") });
  }
  return { buttons, bad };
}

function renderButtons() {
  const { buttons, bad } = parseButtons(cfg.buttons);
  $("quick").replaceChildren(
    ...buttons.map((spec) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = spec.label;
      b.title = spec.prompt;
      b.disabled = !roomReady;
      b.addEventListener("click", () => runButton(spec));
      return b;
    }),
  );
  $("quick").hidden = !buttons.length;
  $("buttons-note").textContent = bad.length ? `Ignored: ${bad.join(", ")}` : "";
}

function runButton(spec) {
  if (abort || !el.model.value) return;
  let since = 0;
  let period = "";
  if (spec.unread) {
    if (!seen?.readTs) return addMsg("error", "Element has no read marker for this room.");
    since = seen.readTs + 1;
    period = `since my read marker (${formatTime(seen.readTs)})`;
  } else if (spec.days) {
    const start = new Date(Date.now() - spec.days * 86400000);
    // whole days keep the oldest part identical all day, so its summary stays cached
    if (spec.days > 1) start.setHours(0, 0, 0, 0);
    since = start.getTime();
    period = `from the past ${spec.days === 1 ? "24 hours" : `${spec.days} days`} (since ${formatTime(since)})`;
  }
  const fill = (p) =>
    (spec.prompt.includes("{period}") ? spec.prompt.replaceAll("{period}", p) : p ? `${spec.prompt} (${p})` : spec.prompt)
      .replace(/ {2,}/g, " ")
      .replace(/ ([:,.?!])/g, "$1");
  ask(fill(period), {
    since,
    mentions: spec.mentions,
    task: fill(since ? "in this period" : ""),
    roomId: spec.unread ? seen.roomId : undefined,
  });
}

$("search").addEventListener("click", searchInput);
$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (abort) return abort.abort();
  const text = el.input.value.trim();
  if (!text || !el.model.value) return;
  el.input.value = "";
  ask(text);
});
el.input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    $("form").requestSubmit();
  }
});
el.model.addEventListener("change", () => {
  save({ model: el.model.value, modelPinned: true });
  loadModelLimit();
});
$("refresh").addEventListener("click", loadModels);
$("buttons").addEventListener("change", (e) => {
  const text = e.target.value.trim();
  if (!text || text === DEFAULT_BUTTONS) {
    chrome.storage.local.remove("buttons");
    cfg.buttons = e.target.value = DEFAULT_BUTTONS;
  } else {
    save({ buttons: text });
  }
  renderButtons();
});
$("forget").addEventListener("click", async () => {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("part:"));
  await chrome.storage.local.remove(keys);
  $("forget").textContent = `Forgot ${keys.length} cached part summaries`;
});
$("clear").addEventListener("click", () => {
  abort?.abort();
  chat = newChat(chat.roomId);
  el.log.replaceChildren();
  saveChat();
});
$("use-ctx").addEventListener("change", (e) => save({ useCtx: e.target.checked }));
$("use-tools").addEventListener("change", (e) => save({ useTools: e.target.checked }));
$("base-url").addEventListener("change", (e) => {
  save({ baseUrl: e.target.value.replace(/\/+$/, "") });
  loadModels();
});
$("num-ctx").addEventListener("change", (e) => save({ numCtx: Number(e.target.value) || DEFAULTS.numCtx }));
$("max-msgs").addEventListener("change", (e) => save({ maxMsgs: Number(e.target.value) || DEFAULTS.maxMsgs }));
el.log.addEventListener("click", async (ev) => {
  const a = ev.target.closest?.("a[data-ref]");
  if (!a || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
  ev.preventDefault();
  const tab = await activeTab();
  if (tab?.id && tab.url && new URL(tab.url).origin === new URL(a.href).origin) {
    chrome.tabs.update(tab.id, { url: a.href, active: true });
  } else {
    window.open(a.href, "_blank", "noopener");
  }
});
el.grant.addEventListener("click", async () => {
  const origin = el.grant.dataset.origin;
  if (origin && (await chrome.permissions.request({ origins: [`${origin}/*`] }))) refreshInfo();
});

chrome.tabs.onActivated.addListener(refreshInfo);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.status === "complete") refreshInfo();
});

await loadCfg();
renderButtons();
prunePartCache();
await refreshInfo();
await loadModels();
