import assert from "node:assert/strict";
// node tests/search.test.mjs [path/to/extract.js]
const { searchRoom } = await import(process.argv[2] ? new URL(process.argv[2], `file://${process.cwd()}/`).href : "../src/extract.js");

const ME = "@wanda:example.org";
const NAMES = { [ME]: "Wanda", "@ana:example.org": "Ana", "@bo:example.org": "Bo" };
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

// n messages, one every 10 min; body(i) decides the text
function makeWorld({ n, body, encrypted = true, search }) {
  const now = Date.now();
  const raw = [];
  for (let i = 0; i < n; i++) {
    const sender = ["@ana:example.org", "@bo:example.org", ME][i % 3];
    raw.push({ event_id: `$e${i}`, sender, origin_server_ts: now - (n - i) * 600000, content: { msgtype: "m.text", body: body(i) } });
    if (i % 4 === 0) raw.push({ event_id: `$r${i}`, type: "m.reaction", sender, origin_server_ts: now - (n - i) * 600000 + 1, content: {} });
  }
  let pages = 0;
  const room = {
    roomId: "!room:example.org",
    currentState: { getStateEvents: (t) => (t === "m.room.encryption" && encrypted ? { algorithm: "m.megolm.v1.aes-sha2" } : null) },
    findEventById: () => undefined,
  };
  const client = {
    getRoom: (id) => (id === room.roomId ? room : null),
    getEventMapper: () => (r) => new Ev(r),
    decryptEventIfNeeded: async () => {},
    createMessagesRequest: async (_r, from, limit) => {
      pages++;
      const end = from === null ? raw.length : Number(from);
      const start = Math.max(0, end - limit);
      return { chunk: raw.slice(start, end).reverse(), end: start > 0 ? String(start) : undefined };
    },
    ...(search ? { search: (opts) => search(opts, raw) } : {}),
  };
  globalThis.window = { mxMatrixClientPeg: { get: () => client } };
  return { raw, pages: () => pages };
}
const ids = (r) => r.messages.map((m) => m.id);
const sortedAsc = (r) => r.messages.every((m, i, a) => !i || a[i - 1].ts <= m.ts);

// encrypted, small room: whole history, case and accent folding, all words required
{
  const w = makeWorld({ n: 500, body: (i) => (i % 50 === 3 ? `Revisión del DEPLOY ${i}` : i % 50 === 4 ? `deploy only ${i}` : `chat ${i}`) });
  const r = await searchRoom("!room:example.org", "revision deploy", 20);
  assert.equal(r.server, false);
  assert.deepEqual(ids(r), w.raw.filter((e) => /^Revisión/.test(e.content.body ?? "")).map((e) => e.event_id));
  assert.equal(r.messages.length, 10);
  assert.ok(sortedAsc(r));
  assert.equal(r.more, false);
  assert.equal(r.capped, false);
  assert.equal(w.pages(), 7); // 625 events
  console.log(`encrypted small room: ${r.messages.length} hits, ${w.pages()} pages, more=${r.more}, capped=${r.capped}`);
}
// encrypted, many matches: stops once the limit is reached, newest first
{
  const w = makeWorld({ n: 10000, body: (i) => (i % 10 === 0 ? `release ${i}` : `chat ${i}`) });
  const r = await searchRoom("!room:example.org", "release", 20);
  const expect = w.raw.filter((e) => /^release/.test(e.content.body ?? "")).slice(-20).map((e) => e.event_id);
  assert.deepEqual(ids(r), expect);
  assert.equal(r.more, true);
  assert.equal(r.capped, false);
  assert.ok(w.pages() <= 3);
  console.log(`encrypted many hits: ${r.messages.length} hits, ${w.pages()} pages, more=${r.more}`);
}
// encrypted, big room, rare word: page cap, reports how far back it looked
{
  const w = makeWorld({ n: 10000, body: (i) => (i === 9990 || i === 100 ? `kubernetes ${i}` : `chat ${i}`) });
  const r = await searchRoom("!room:example.org", "Kubernetes", 20);
  assert.deepEqual(ids(r), ["$e9990"]);
  assert.equal(r.capped, true);
  assert.equal(r.more, false);
  assert.equal(w.pages(), 30);
  assert.ok(r.back < Date.now() && r.back > w.raw[0].origin_server_ts);
  console.log(`encrypted page cap: ${r.messages.length} hit, ${w.pages()} pages, back to ${new Date(r.back).toISOString()}`);
}
// unencrypted: server search, paged by next_batch, oldest first, non-messages dropped
{
  let calls = 0;
  const search = async ({ body, next_batch }, raw) => {
    calls++;
    const cat = body.search_categories.room_events;
    assert.deepEqual(cat.filter.rooms, ["!room:example.org"]);
    assert.equal(cat.order_by, "recent");
    const hits = raw.filter((e) => !e.type && e.content.body.includes(cat.search_term)).reverse();
    const from = Number(next_batch ?? 0);
    const page = hits.slice(from, from + 8);
    const results = page.map((result) => ({ rank: 1, result }));
    if (!next_batch) results.push({ rank: 1, result: { event_id: "$state", type: "m.room.name", origin_server_ts: 1, content: {} } });
    return { search_categories: { room_events: { count: hits.length, results, next_batch: from + 8 < hits.length ? String(from + 8) : undefined } } };
  };
  const w = makeWorld({ n: 3000, encrypted: false, search, body: (i) => (i % 100 === 1 ? `budget ${i}` : `chat ${i}`) });
  const r = await searchRoom("!room:example.org", "budget", 20);
  assert.equal(r.server, true);
  assert.equal(w.pages(), 0);
  assert.equal(calls, 3);
  assert.equal(r.messages.length, 20);
  assert.ok(sortedAsc(r));
  assert.equal(r.messages.at(-1).id, "$e2901");
  assert.equal(r.more, true);
  console.log(`server search: ${r.messages.length} hits in ${calls} calls, more=${r.more}`);

  const few = makeWorld({ n: 3000, encrypted: false, search, body: (i) => (i === 7 ? `budget ${i}` : `chat ${i}`) });
  const r2 = await searchRoom("!room:example.org", "budget", 20);
  assert.deepEqual(ids(r2), ["$e7"]);
  assert.equal(r2.more, false);
  assert.equal(r2.capped, false);
  assert.equal(few.pages(), 0);
  console.log("server search, one old hit: whole history, no pages");
}
// unencrypted but the server refuses search: falls back to the scan
{
  const w = makeWorld({ n: 400, encrypted: false, search: async () => { throw new Error("M_UNRECOGNIZED"); }, body: (i) => (i === 50 ? "budget plan" : `chat ${i}`) });
  const r = await searchRoom("!room:example.org", "budget", 20);
  assert.equal(r.server, false);
  assert.deepEqual(ids(r), ["$e50"]);
  assert.ok(w.pages() > 0);
  console.log("search error falls back to scan");
}
// reply fallback stripped, reply relation kept; unknown room
{
  makeWorld({ n: 10, body: (i) => `chat ${i}` });
  const w = makeWorld({ n: 10, body: (i) => (i === 5 ? "> <@ana:example.org> old quote budget\n\nnew text budget" : `chat ${i}`) });
  w.raw.find((e) => e.event_id === "$e5").content["m.relates_to"] = { "m.in_reply_to": { event_id: "$e2" } };
  const r = await searchRoom("!room:example.org", "budget", 20);
  assert.equal(r.messages[0].body, "new text budget");
  assert.equal(r.messages[0].replyTo, "$e2");
  assert.ok((await searchRoom("!other:example.org", "x", 20)).error);
  console.log("reply fallback stripped; unknown room errors");
}
console.log("ALL OK");
