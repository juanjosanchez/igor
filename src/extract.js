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
    me: client.getUser?.(myId)?.displayName || myId,
    messages,
    truncated,
    readTs,
  };
}
