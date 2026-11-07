// Injected into the Element tab with world: "MAIN". Must be self-contained:
// it is serialized by chrome.scripting.executeScript.
export async function extractRoom(limit, since = 0) {
  const peg = window.mxMatrixClientPeg;
  const client =
    (peg && (peg.safeGet?.() ?? peg.get?.() ?? peg.matrixClient)) || null;
  if (!client) return { error: "no-client" };

  const match = location.hash.match(/#\/room\/([^/?]+)/);
  const ref = match ? decodeURIComponent(match[1]) : null;
  if (!ref) return { error: "no-room" };

  const room =
    client.getRoom(ref) ||
    client
      .getRooms()
      .find(
        (r) =>
          r.getCanonicalAlias() === ref || r.getAltAliases().includes(ref),
      );
  if (!room) return { error: "unknown-room", ref };

  const isMessage = (e) =>
    e.getType() === "m.room.message" &&
    !e.isRedacted() &&
    !e.isDecryptionFailure?.() &&
    typeof e.getContent().body === "string";

  // The live timeline can be a short window without a back token, so page
  // /messages directly from the newest event instead.
  let events = room.getLiveTimeline().getEvents().filter(isMessage);
  // with a time window, report when its start could not be reached
  let truncated = since > 0 && !(events[0]?.getTs() < since);
  if (client.createMessagesRequest) {
    const mapper = client.getEventMapper();
    const fetched = [];
    let from = null;
    let more = true;
    const enough = () =>
      since
        ? fetched.length > 0 && fetched[fetched.length - 1].getTs() < since
        : fetched.filter(isMessage).length >= limit;
    try {
      for (let i = 0; i < (since ? 50 : 10) && !enough(); i++) {
        const page = await client.createMessagesRequest(room.roomId, from, 100, "b");
        const batch = (page.chunk || []).map(mapper);
        await Promise.all(batch.map((e) => client.decryptEventIfNeeded?.(e)));
        fetched.push(...batch);
        from = page.end;
        if (!from || !batch.length) {
          more = false;
          break;
        }
      }
      events = fetched.filter(isMessage).sort((a, b) => a.getTs() - b.getTs());
      truncated = since > 0 && more && !enough();
    } catch {
      // fall back to whatever the live timeline holds
    }
  }
  const inWindow = events.filter((e) => e.getTs() >= since);
  if (since && inWindow.length > limit) truncated = true;

  const myId = client.getUserId();
  const senderOf = (e) => e.sender?.name || e.getSender();
  const byId = new Map(events.map((e) => [e.getId(), e]));
  // in a two-person room everything the other person says is addressed to the user
  const direct = (room.getJoinedMemberCount?.() ?? 3) <= 2;
  const handles = [myId, room.getMember?.(myId)?.name, myId?.slice(1).split(":")[0]]
    .filter((h) => h && h.length > 2)
    .map((h) => h.toLowerCase());
  const toMe = (e, content, body, parent) => {
    if (e.getSender() === myId) return false;
    const mentions = content["m.mentions"];
    if (direct || parent?.getSender?.() === myId || mentions?.room || mentions?.user_ids?.includes(myId)) return true;
    const html = (content.formatted_body ?? "").replace(/<mx-reply>[\s\S]*?<\/mx-reply>/, "");
    const text = `${body}\n${html}`.toLowerCase();
    return text.includes("@room") || handles.some((h) => text.includes(h));
  };
  const messages = inWindow.slice(-limit).map((e) => {
    const content = e.getContent();
    const replyTo = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
    let body = content.body;
    // legacy reply fallback quotes the parent; the reply relation replaces it
    if (replyTo && body.startsWith("> ")) body = body.replace(/^(?:>.*(?:\n|$))+\n*/, "") || body;
    const parent = replyTo && (byId.get(replyTo) ?? room.findEventById?.(replyTo));
    return {
      id: e.getId(),
      ts: e.getTs(),
      sender: senderOf(e),
      body,
      ...(replyTo ? { replyTo, replyToSender: parent ? senderOf(parent) : undefined } : {}),
      ...(toMe(e, content, body, parent) ? { toMe: true } : {}),
    };
  });

  const readId = room.getAccountData?.("m.fully_read")?.getContent()?.event_id ?? room.getEventReadUpTo?.(myId);
  let readTs = readId ? (byId.get(readId) ?? room.findEventById?.(readId))?.getTs() : undefined;
  if (readId && readTs === undefined && client.fetchRoomEvent) {
    try {
      readTs = (await client.fetchRoomEvent(room.roomId, readId)).origin_server_ts;
    } catch {
      // no usable read marker
    }
  }

  return {
    roomId: room.roomId,
    name: room.name,
    topic: room.currentState?.getStateEvents("m.room.topic", "")?.getContent()
      ?.topic,
    memberCount: room.getJoinedMemberCount?.(),
    encrypted: !!room.currentState?.getStateEvents("m.room.encryption", ""),
    me: client.getUser?.(myId)?.displayName || myId,
    messages,
    truncated,
    readTs,
  };
}

// Also injected, so also self-contained. The server's search index covers the
// whole history but only of unencrypted rooms; encrypted history is paged and
// matched here, newest first, up to a page cap.
export async function searchRoom(roomId, query, limit) {
  const peg = window.mxMatrixClientPeg;
  const client =
    (peg && (peg.safeGet?.() ?? peg.get?.() ?? peg.matrixClient)) || null;
  const room = client?.getRoom(roomId);
  if (!room) return { error: "the room is no longer available" };

  const isMessage = (e) =>
    e.getType() === "m.room.message" &&
    !e.isRedacted() &&
    !e.isDecryptionFailure?.() &&
    typeof e.getContent().body === "string";
  const mapper = client.getEventMapper();
  let found = [];
  let server = false;
  let more = false;
  let capped = false;
  let back;

  if (!room.currentState?.getStateEvents("m.room.encryption", "") && client.search) {
    try {
      let next;
      do {
        const res = await client.search({
          body: {
            search_categories: {
              room_events: { search_term: query, filter: { rooms: [roomId], limit }, order_by: "recent" },
            },
          },
          next_batch: next,
        });
        const cat = res.search_categories?.room_events ?? {};
        found.push(...(cat.results ?? []).map((r) => mapper(r.result)).filter(isMessage));
        next = cat.next_batch;
      } while (next && found.length < limit);
      server = true;
      more = !!next || found.length > limit;
    } catch {
      // no usable server search: scan instead
      found = [];
    }
  }

  if (!server) {
    const fold = (s) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    const words = fold(query).replace(/"/g, " ").split(/\s+/).filter(Boolean);
    let from = null;
    let start = false;
    for (let i = 0; i < 30 && found.length < limit && !start; i++) {
      const page = await client.createMessagesRequest(roomId, from, 100, "b");
      const batch = (page.chunk || []).map(mapper);
      await Promise.all(batch.map((e) => client.decryptEventIfNeeded?.(e)));
      for (const e of batch.filter(isMessage)) {
        back = e.getTs();
        const body = fold(e.getContent().body);
        if (words.every((w) => body.includes(w))) found.push(e);
      }
      from = page.end;
      start = !from || !batch.length;
    }
    more = found.length > limit || (found.length === limit && !start);
    capped = !start && found.length < limit;
  }

  const senderOf = (e) => e.sender?.name || e.getSender();
  const messages = found
    .slice(0, limit)
    .reverse()
    .map((e) => {
      const content = e.getContent();
      const replyTo = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
      let body = content.body;
      if (replyTo && body.startsWith("> ")) body = body.replace(/^(?:>.*(?:\n|$))+\n*/, "") || body;
      const parent = replyTo && room.findEventById?.(replyTo);
      return {
        id: e.getId(),
        ts: e.getTs(),
        sender: senderOf(e),
        body,
        ...(replyTo ? { replyTo, replyToSender: parent ? senderOf(parent) : undefined } : {}),
      };
    });
  return { roomId, messages, server, more, capped, back };
}
