import assert from "node:assert/strict";
// node tests/extract.test.mjs [path/to/extract.js]
const { extractRoom } = await import(process.argv[2] ? new URL(process.argv[2], `file://${process.cwd()}/`).href : "../src/extract.js");

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

function makeWorld({ days, everyMin, members = 3, readIdx = null, extra = [] }) {
  const now = Date.now();
  const raw = [];
  const n = Math.floor((days * 1440) / everyMin);
  for (let i = 0; i < n; i++) {
    const ts = now - (n - i) * everyMin * 60000;
    const sender = ["@ana:example.org", "@bo:example.org", ME][i % 3];
    raw.push({ event_id: `$e${i}`, sender, origin_server_ts: ts, content: { msgtype: "m.text", body: `msg ${i}` } });
    if (i % 5 === 0) raw.push({ event_id: `$r${i}`, type: "m.reaction", sender, origin_server_ts: ts + 1, content: {} });
  }
  for (const e of extra) raw.push({ origin_server_ts: now - 1000, ...e });
  raw.sort((a, b) => a.origin_server_ts - b.origin_server_ts);
  let pages = 0;
  const readId = readIdx === null ? null : `$e${readIdx}`;
  const room = {
    roomId: "!room:example.org",
    name: "Test",
    currentState: { getStateEvents: () => null },
    getCanonicalAlias: () => null,
    getAltAliases: () => [],
    getJoinedMemberCount: () => members,
    getMember: (id) => ({ name: NAMES[id] }),
    getLiveTimeline: () => ({ getEvents: () => raw.slice(-20).map((r) => new Ev(r)) }),
    findEventById: (id) => raw.slice(-20).map((r) => new Ev(r)).find((e) => e.getId() === id),
    getAccountData: (t) => (t === "m.fully_read" && readId ? { getContent: () => ({ event_id: readId }) } : undefined),
    getEventReadUpTo: () => null,
  };
  const client = {
    getRoom: (id) => (id === room.roomId ? room : null),
    getRooms: () => [room],
    getUserId: () => ME,
    getUser: (id) => ({ displayName: NAMES[id] }),
    getEventMapper: () => (r) => new Ev(r),
    decryptEventIfNeeded: async () => {},
    fetchRoomEvent: async (_r, id) => raw.find((r) => r.event_id === id),
    createMessagesRequest: async (_r, from, limit) => {
      pages++;
      const end = from === null ? raw.length : Number(from);
      const start = Math.max(0, end - limit);
      return { chunk: raw.slice(start, end).reverse(), end: start > 0 ? String(start) : undefined };
    },
  };
  globalThis.window = { mxMatrixClientPeg: { get: () => client } };
  globalThis.location = { hash: `#/room/${room.roomId}` };
  return { now, raw, pages: () => pages };
}

// 7-day window inside 30 days of history
{
  const w = makeWorld({ days: 30, everyMin: 10 });
  const since = w.now - 7 * 86400000;
  const r = await extractRoom(5000, since);
  const expected = w.raw.filter((e) => !e.type && e.origin_server_ts >= since).length;
  assert.equal(r.messages.length, expected);
  assert.ok(r.messages.every((m) => m.ts >= since));
  assert.ok(r.messages.every((m, i, a) => !i || a[i - 1].ts <= m.ts));
  assert.equal(r.truncated, false);
  console.log(`7d window: ${r.messages.length} msgs, ${w.pages()} pages, truncated=${r.truncated}`);
}
// window reaching the room start
{
  const w = makeWorld({ days: 30, everyMin: 20 });
  const r = await extractRoom(5000, w.now - 60 * 86400000);
  assert.equal(r.truncated, false);
  assert.equal(r.messages.length, w.raw.filter((e) => !e.type).length);
  console.log(`60d window, 30d room: ${r.messages.length} msgs, truncated=${r.truncated}`);
}
// window beyond the 50-page cap
{
  const w = makeWorld({ days: 120, everyMin: 10 });
  const r = await extractRoom(5000, w.now - 60 * 86400000);
  assert.equal(r.truncated, true);
  assert.equal(w.pages(), 50);
  console.log(`60d window, 120d room: ${r.messages.length} msgs from ${new Date(r.messages[0].ts).toISOString()}, truncated=${r.truncated}`);
}
// count-based mode unchanged
{
  const w = makeWorld({ days: 30, everyMin: 10 });
  const r = await extractRoom(200, 0);
  assert.equal(r.messages.length, 200);
  assert.equal(r.truncated, false);
  assert.equal(r.messages.at(-1).id, w.raw.filter((e) => !e.type).at(-1).event_id);
  console.log(`limit 200: ${r.messages.length} msgs, ${w.pages()} pages`);
}
// addressed-to-me flags and read marker
{
  const w = makeWorld({
    days: 1, everyMin: 60, readIdx: 3,
    extra: [
      { event_id: "$n1", sender: "@ana:example.org", content: { body: "wanda can you check?" } },
      { event_id: "$n2", sender: "@ana:example.org", content: { body: "Hi", "m.mentions": { user_ids: [ME] } } },
      { event_id: "$n3", sender: "@bo:example.org", content: { body: "ok", "m.relates_to": { "m.in_reply_to": { event_id: "$e2" } } } },
      { event_id: "$n4", sender: "@bo:example.org", content: { body: "@room deploy at 5" } },
      { event_id: "$n5", sender: "@bo:example.org", content: { body: "lunch?" } },
      { event_id: "$n6", sender: ME, content: { body: "wanda here" } },
      { event_id: "$n7", sender: "@ana:example.org", content: { body: "see", formatted_body: '<mx-reply><a href="https://matrix.to/#/@wanda:example.org">x</a></mx-reply>see' } },
    ],
  });
  const r = await extractRoom(5000, w.now - 86400000 - 3600000);
  const flag = Object.fromEntries(r.messages.map((m) => [m.id, !!m.toMe]));
  assert.deepEqual([flag.$n1, flag.$n2, flag.$n3, flag.$n4, flag.$n5, flag.$n6, flag.$n7], [true, true, true, true, false, false, false]);
  assert.equal(r.readTs, w.raw.find((e) => e.event_id === "$e3").origin_server_ts);
  console.log("toMe flags and readTs (via fetchRoomEvent) OK");
}
// direct chat: everything from the other person
{
  makeWorld({ days: 1, everyMin: 60, members: 2 });
  const r = await extractRoom(5000, 0);
  assert.ok(r.messages.every((m) => !!m.toMe === (m.sender !== "Wanda")));
  console.log("direct chat flags OK");
}
console.log("ALL OK");
