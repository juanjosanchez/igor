#!/usr/bin/env python3
"""Harder synthetic benchmarks for Igor: needle recall grid, abstention, and tool-use depth.

  python3 -I hard.py gen                      # (re)generate datasets/ (seeded, deterministic)
  python3 -I hard.py run <ollama model> [--cells 2k,6k,12k] [--seeds 6] [--tools-n 30]
  python3 -I hard.py report results/hard-*.jsonl

All content is synthetic with known ground truth; scoring is exact matching (no LLM judge). The
system prompt, message format and tool loop mirror src/panel.js. Answer values (SPICE-NN) never
occur in the filler, so substring matching cannot be fooled by filler text.
"""
import argparse, json, math, os, random, re, subprocess, sys, time, urllib.request

BASE = os.environ.get("OLLAMA_URL", "http://localhost:11434")
NUM_CTX = 24576
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "datasets")
CELLS = {"2k": 70, "6k": 210, "12k": 420}
MAX_ROUNDS = 5

PEOPLE = ["Alex", "Jesse", "Marga", "Mario", "Hector", "Carmen", "Juanjo", "Samuel"]
PROJECTS = ["Atlas", "Borealis", "Cobalt", "Dune", "Ember", "Fjord", "Garnet", "Helix", "Ibis", "Juniper", "Kestrel", "Lumen"]
SPICES = ["SAFFRON", "SUMAC", "CARDAMOM", "PAPRIKA", "TURMERIC", "FENNEL", "CUMIN", "ANISE", "CLOVE", "MACE", "NUTMEG", "SESAME",
          "CORIANDER", "CINNAMON", "GINGER", "PEPPER", "CHILI", "VANILLA", "TARRAGON", "BASIL", "OREGANO", "THYME", "SAGE", "DILL"]
CODE_RE = re.compile(r"[A-Z]{4,}-\d{2}")
FILLER = [
    "I looked at {P} this morning and the nightly run is green again.",
    "Can someone review my patch for {P}? It is small, mostly cleanup.",
    "{P} regressed a bit last week, I am bisecting now.",
    "We should talk about {P} in the sync tomorrow.",
    "Thanks {who}, that fixed the flaky test in {P}.",
    "I will be out Friday so ping {who} about {P} if it is urgent.",
    "The CI queue is slow again, {P} jobs are waiting for runners.",
    "Does anyone remember why {P} pins that old compiler version?",
    "Merged the rebase for {P}, please pull before you push.",
    "{who}, did you get a chance to try the new linter on {P}?",
    "Still blocked on review for {P}, no rush but it is on my list.",
    "The benchmark noise on {P} looks better after the machine reboot.",
    "Reminder: the docs for {P} need a pass before the next release.",
    "I opened a thread about {P} in the engineering channel, thoughts welcome.",
    "Lunch is at the usual place, {who} is bringing the cake.",
    "The mirror was down for a while, {P} builds failed because of it.",
    "I think the {P} migration plan needs one more iteration.",
    "Good catch {who}, I had missed that in {P}.",
]
ATTRS = {
    "staging": ("the staging box for {P} is {C}", "Which machine is the pre-production environment for {P}?", "update: staging for {P} moved, the box is now {C}"),
    "deploy": ("{P} deploys go out in the {C} window", "In which slot does {P} ship to production?", "heads up, {P} now ships in the {C} window instead"),
    "oncall": ("the on-call rotation for {P} is called {C}", "What is the name of the pager schedule for {P}?", "correction, the {P} on-call rotation was renamed to {C}"),
    "freeze": ("the code freeze tag for {P} is {C}", "Which label marks the end of feature work for {P}?", "correction: the freeze tag for {P} is {C} now, ignore the old one"),
    "cost": ("{P} is billed to cost center {C}", "Which budget code pays for {P}?", "finance moved {P} to cost center {C}"),
    "design": ("the design doc for {P} lives under {C}", "Where is the architecture write-up for {P} stored?", "the {P} design doc was relocated, it is under {C} now"),
    "support": ("the support alias for {P} is {C}", "Which mailing alias handles customer issues for {P}?", "support for {P} now goes to alias {C}"),
    "rollback": ("the rollback plan for {P} is filed as {C}", "What is the identifier of the contingency procedure for {P}?", "the {P} rollback plan was refiled as {C}"),
}
LEAD = ["FYI, ", "btw ", "noted: ", "just so you know, ", ""]


def ts(i):
    mins = i * 3
    day = 27 + (mins // 1440)
    return f"2026-10-{day:02d} {(9 + (mins % 1440) // 60) % 24:02d}:{mins % 60:02d}"


def filler_line(r, who=None):
    return r.choice(FILLER).format(P=r.choice(PROJECTS), who=who or r.choice(PEOPLE))


# ---------------------------------------------------------------- generators

def gen_recall(seed, cell):
    r = random.Random(f"recall-{cell}-{seed}")
    n = CELLS[cell]
    projs = r.sample(PROJECTS, 8)
    attrs = r.sample(sorted(ATTRS), 8)
    spices = iter(r.sample(SPICES, len(SPICES)))
    code = lambda: f"{next(spices)}-{r.randint(10, 99)}"
    a_dec, a_d1, a_d2, a_d3, a_r1, a_r2, a_abs1, a_abs2 = attrs

    plants = []  # (key, text)
    group = projs[:3]
    gcodes = {p: code() for p in group}
    for p in group:
        plants.append((("dec", p), ATTRS[a_dec][0].format(P=p, C=gcodes[p])))
    direct = {}
    for a, p in zip((a_d1, a_d2, a_d3), projs[3:6]):
        direct[a] = (p, code())
        plants.append((("dir", a), ATTRS[a][0].format(P=p, C=direct[a][1])))
    rev = {}
    for a, p in zip((a_r1, a_r2), projs[6:8]):
        old, new = code(), code()
        rev[a] = (p, old, new)
        plants.append((("rev0", a), ATTRS[a][0].format(P=p, C=old)))
        plants.append((("rev1", a), ATTRS[a][2].format(P=p, C=new)))

    k = len(plants)
    slots = [int(n * (0.03 + 0.92 * (i + r.random()) / k)) for i in range(k)]
    for i in range(1, k):
        slots[i] = max(slots[i], slots[i - 1] + 1)
    while True:
        order = list(range(k))
        r.shuffle(order)
        pos = {plants[j][0]: slots[order[j]] for j in range(k)}
        if all(pos[("rev1", a)] - pos[("rev0", a)] >= max(3, n // 8) for a in rev):
            break

    at = {pos[key]: text for (key, text) in plants}
    messages = []
    for i in range(n):
        who = r.choice(PEOPLE)
        body = LEAD[r.randrange(len(LEAD))] + at[i] if i in at else filler_line(r, who)
        messages.append({"ref": i + 1, "ts": ts(i), "sender": who, "body": body})

    def depth(i):
        return round(i / n, 3)

    all_codes = set(gcodes.values()) | {c for _, c in direct.values()} | {c for v in rev.values() for c in v[1:]}
    qs = []

    def present(typ, a, p, expected, at_pos):
        qs.append({"type": typ, "q": ATTRS[a][1].format(P=p), "expected": expected,
                   "forbidden": sorted(all_codes - {expected}), "depth": depth(at_pos)})

    for p in r.sample(group, 2):
        present("decoy", a_dec, p, gcodes[p], pos[("dec", p)])
    for a, (p, c) in direct.items():
        present("direct", a, p, c, pos[("dir", a)])
    for a, (p, old, new) in rev.items():
        present("revision", a, p, new, pos[("rev1", a)])
    qs.append({"type": "absent_near", "q": ATTRS[a_dec][1].format(P=projs[3]), "expected": None, "forbidden": [], "depth": None})
    qs.append({"type": "absent_near", "q": ATTRS[a_d1][1].format(P=group[0]), "expected": None, "forbidden": [], "depth": None})
    qs.append({"type": "absent_full", "q": ATTRS[a_abs1][1].format(P=r.choice(PROJECTS)), "expected": None, "forbidden": [], "depth": None})
    qs.append({"type": "absent_full", "q": ATTRS[a_abs2][1].format(P=r.choice(PROJECTS)), "expected": None, "forbidden": [], "depth": None})
    return {"id": f"recall-{cell}-{seed}", "cell": cell, "seed": seed, "messages": messages, "questions": qs}


STATES = ["FOMO", "burnout", "insomnia", "stage fright", "wanderlust", "analysis paralysis"]
STRUGGLE = ["You struggle?", "You stress about this?", "You feel stuck?"]


def gen_reply(kind, i):
    """Reply-attribution scenarios. 'self_attr' mirrors a real failure: B replies to A's remark with a
    first-person statement and models attribute it to A. 'accept' has two competing proposals and a
    reply ("fine by me") whose referent is only identifiable through the reply relation."""
    r = random.Random(f"reply-{kind}-{i}")
    names = r.sample(PEOPLE, 5)
    msgs = []

    def add(sender, body, reply_to=None):
        m = {"ref": len(msgs) + 1, "ts": ts(len(msgs)), "sender": sender, "body": body}
        if reply_to:
            m["reply_to"] = reply_to
        msgs.append(m)
        return m["ref"]

    def chatter(k, pool):
        for _ in range(k):
            add(r.choice(pool), filler_line(r))

    others = names[3:]
    for _ in range(r.randint(4, 9)):
        add(r.choice(names), filler_line(r))
    if kind == "self_attr":
        a, b = names[0], names[1]
        state = r.choice(STATES)
        dist = r.choice([0, 1, 3, 5])
        tgt = add(a, f"{r.choice(STRUGGLE)} I find it overwhelming tbh.")
        chatter(dist, others)
        add(b, f"Yeah, I suffer from {state} quite a bit lately.", reply_to=tgt)
        chatter(r.randint(3, 6), others)
        qs = [(f"Who suffers from {state}?", b, [a] + others, "name"), ("Who finds it overwhelming?", a, [b] + others, "name")]
    else:
        a, b, c = names[0], names[1], names[2]
        c1, c2 = (f"{s}-{r.randint(10, 99)}" for s in r.sample(SPICES, 2))
        ra = add(a, f"I propose we use {c1} for the release tag.")
        chatter(r.randint(0, 2), others)
        rb = add(b, f"I would rather go with {c2} for the release tag.")
        target_is_a = r.random() < 0.5
        dist = 1 if not target_is_a else len(msgs) - ra
        add(c, r.choice(["Fine by me, let's do that one.", "Sounds good to me.", "Agreed, that works."]), reply_to=ra if target_is_a else rb)
        chatter(r.randint(2, 5), others)
        want, other_code, who, other_who = (c1, c2, a, b) if target_is_a else (c2, c1, b, a)
        qs = [(f"Which release tag did {c} agree to?", want, [other_code], "value"), (f"Whose proposal was {c} agreeing with?", who, [other_who] + others, "name")]
    return {"id": f"reply-{kind}-{i}", "kind": kind, "distance": dist, "messages": msgs,
            "questions": [{"q": q, "expected": e, "forbidden": f, "answer": t} for q, e, f, t in qs]}


def encode_reply(m, by_ref, enc):
    if "reply_to" not in m or enc == "plain":
        return format_msg(m)
    tgt = by_ref[m["reply_to"]]
    if enc == "fallback":
        return format_msg({**m, "body": f"> <@{tgt['sender'].lower()}:example.org> {tgt['body']}\n\n{m['body']}"})
    return f"[#{m['ref']}] [{m['ts']}] {m['sender']} (replying to [#{tgt['ref']}] {tgt['sender']}): {m['body']}"


def product(r):
    a = r.choice(["Zan", "Vor", "Qui", "Mel", "Tha", "Pri", "Kex", "Dro", "Bly", "Nox"])
    b = r.choice(["lith", "vane", "mora", "tek", "wick", "dara", "quar", "phel"])
    return {"name": f"{a}{b}-{r.randint(2, 9)}", "token": (a + b).lower()}


def result_block(title, url, snippet):
    return f"{title}\n{url}\n{snippet}"


def gen_tools(category, i):
    r = random.Random(f"tools-{category}-{i}")
    spices = iter(r.sample(SPICES, len(SPICES)))
    code = lambda: f"{next(spices)}-{r.randint(10, 99)}"
    prods = []
    while len(prods) < 5:
        p = product(r)
        if all(p["token"] != q["token"] for q in prods):
            prods.append(p)
    target, other = prods[0], prods[1:]
    for p in prods:
        p["code"] = code()
        p["slug"] = p["token"] + "-notes"
        p["url"] = f"https://news.example.org/{p['slug']}"
    distract = [result_block(f"{p['name']} launch notes", p["url"], f"{p['name']} launch codename is {p['code']}.") for p in other]
    item = {"id": f"tools-{category}-{i}", "category": category, "tools": ["web_search", "fetch_url"], "room": None,
            "products": [target], "distractors": distract, "distractor_codes": [p["code"] for p in other]}
    q = f"Look it up online: what is the launch codename of {target['name']}?"

    def hit(p, with_fact=True):
        snip = f"{p['name']} launch codename is {p['code']}." if with_fact else f"Read the full changelog for {p['name']} on the project site."
        return result_block(f"{p['name']} launch notes", p["url"], snip)

    if category == "search":
        target["hit"] = hit(target)
    elif category == "search_fetch":
        target["hit"] = hit(target, with_fact=False)
        target["page"] = f"Changelog for {target['name']}. Release notes follow. The launch codename is {target['code']}. Other sections omitted."
    elif category == "decoy_tools":
        target["hit"] = hit(target)
        item["tools"] = ["web_search", "fetch_url", "web_search_images", "fetch_pdf"]
    elif category == "two_subjects":
        second = other[0]
        second["hit"] = hit(second)
        target["hit"] = hit(target)
        item["products"] = [target, second]
        item["distractors"] = distract[1:]
        item["distractor_codes"] = [p["code"] for p in other[1:]]
        q = f"Look it up online: what are the launch codenames of {target['name']} and {second['name']}?"
    elif category in ("restraint", "older"):
        n_ctx = 30 if category == "restraint" else 20
        base_ref = 1 if category == "restraint" else 101
        msgs = []
        fact_at = r.randrange(5, n_ctx - 3)
        for j in range(n_ctx):
            who = r.choice(PEOPLE)
            body = f"the launch codename of {target['name']} is {target['code']}" if category == "restraint" and j == fact_at else filler_line(r, who)
            msgs.append({"ref": base_ref + j, "ts": ts(j + (0 if category == "restraint" else 60)), "sender": who, "body": body})
        item["room"] = msgs
        item["tools"] = ["web_search", "fetch_url"] if category == "restraint" else ["web_search", "fetch_url", "get_older_messages"]
        if category == "older":
            old = []
            fact_old = r.randrange(5, 27)
            for j in range(30):
                who = r.choice(PEOPLE)
                body = f"the launch codename of {target['name']} is {target['code']}" if j == fact_old else filler_line(r, who)
                old.append({"ref": 71 + j, "ts": ts(j + 30), "sender": who, "body": body})
            item["older"] = old
            q = f"Earlier in this room someone mentioned the launch codename of {target['name']}. What was it? You can only see the latest messages, so look further back in the room history if needed."
        else:
            item["distractors"], item["distractor_codes"] = [], []
    item["question"] = q
    return item


# ---------------------------------------------------------------- prompts (mirror src/panel.js)

def format_msg(m):
    return f"[#{m['ref']}] [{m['ts']}] {m['sender']}: {m['body']}"


def system_prompt(messages=None, use_tools=False, answer_format=False, formatter=None, reply_note=False):
    formatter = formatter or format_msg
    base = ("The current local date and time is 2026-10-29 10:00 (Thursday, timezone Europe/Madrid). Message timestamps use the same timezone. "
            'When the user says "today", they mean only messages dated 2026-10-29; ignore messages from other dates, and say so if there are none. '
            "You are Igor, an assistant living in a sidebar next to the Element (Matrix) chat client. "
            "Answer questions about the conversation in the current room and help the user think about it. "
            "Be concise. If the answer is not in the provided messages, say so instead of guessing. "
            "Each room message starts with a reference like [#12]. When you summarize or point to parts of the discussion, cite the relevant messages with these references, e.g. [#12] or [#12-#20], so the user can jump to them. Only cite references that appear in the messages.")
    if use_tools:
        names = use_tools if isinstance(use_tools, list) else ["web_search", "fetch_url", "get_older_messages"]
        web = [n for n in names if n in ("web_search", "fetch_url")]
        parts = ([f"use {'/'.join(web)} for current or external facts"] if web else []) + (["get_older_messages for earlier room history"] if "get_older_messages" in names else [])
        base += " You have tools: " + " and ".join(parts) + ", only when needed."
    if reply_note:
        base += " A message written as 'Name (replying to [#M] Other)' is a reply to message [#M]; what it says is about or answers that message, and any first-person statement in it belongs to the replier."
    if answer_format:
        base += " Test format: reply with only the value itself (not a message reference), or exactly NOT_FOUND if the messages do not contain it."
    if messages is None:
        return base
    return f'{base}\n\nThe user is "Tester". Current room: "Test room".\nMost recent {len(messages)} messages, oldest first:\n\n' + "\n".join(map(formatter, messages))


def tool_def(name, desc, props, required):
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required}}}


TOOL_DEFS = {
    "web_search": tool_def("web_search", "Search the web. Returns titles, URLs and snippets of the top results.", {"query": {"type": "string", "description": "Search query"}}, ["query"]),
    "fetch_url": tool_def("fetch_url", "Fetch a web page and return its text content (truncated).", {"url": {"type": "string", "description": "Absolute http(s) URL"}}, ["url"]),
    "get_older_messages": tool_def("get_older_messages", "Back-paginate the current Element room and return messages older than those already in your context. Use when the user asks about earlier discussion you cannot see.", {"count": {"type": "number", "description": "How many older messages (max 100)"}}, ["count"]),
    "web_search_images": tool_def("web_search_images", "Search the web for images. Returns image URLs and captions.", {"query": {"type": "string", "description": "Image search query"}}, ["query"]),
    "fetch_pdf": tool_def("fetch_pdf", "Download a PDF from a URL and return its extracted text.", {"url": {"type": "string", "description": "Absolute URL of a PDF file"}}, ["url"]),
}

# mirrors webSearch in src/panel.js
SNIPPET_NOTE = "These are only snippets. If they do not state the answer, open the most relevant result with fetch_url before answering."

# ---------------------------------------------------------------- ollama

def post(path, body, timeout=900):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def chat(model, messages, tools=None, predict=40):
    body = {"model": model, "stream": False, "think": False, "messages": messages,
            "options": {"num_ctx": NUM_CTX, "num_predict": predict, "temperature": 0}}
    if tools:
        body["tools"] = tools
    t0 = time.time()
    r = post("/api/chat", body)
    r["_wall"] = time.time() - t0
    return r


def unload_all():
    for m in json.loads(urllib.request.urlopen(BASE + "/api/ps").read())["models"]:
        post("/api/generate", {"model": m["name"], "keep_alive": 0})
    time.sleep(2)


def truncation_events(since_epoch):
    try:
        out = subprocess.run(["journalctl", "--user", "-u", "ollama", "--since", f"@{int(since_epoch)}", "--no-pager"],
                             capture_output=True, text=True, timeout=30).stdout
        return sum("truncating input prompt" in l for l in out.splitlines())
    except Exception:
        return None


# ---------------------------------------------------------------- running

def run_recall(model, ctx_item, out):
    sysmsg = system_prompt(ctx_item["messages"], answer_format=True)
    for qi, q in enumerate(ctx_item["questions"]):
        r = chat(model, [{"role": "system", "content": sysmsg}, {"role": "user", "content": q["q"]}], predict=24)
        ans = r["message"].get("content", "").strip()
        up = ans.upper()
        if q["expected"] is None:
            ok = ("NOT_FOUND" in up or "NOT FOUND" in up) and not CODE_RE.search(up)
        else:
            ok = q["expected"] in up and not any(f in up for f in q["forbidden"])
        out.write(json.dumps({"bench": "recall", "id": ctx_item["id"], "cell": ctx_item["cell"], "type": q["type"], "depth": q["depth"],
                              "pass": ok, "answer": ans[:80], "expected": q["expected"], "wall": round(r["_wall"], 2),
                              "prompt_tokens": r.get("prompt_eval_count") if qi == 0 else None}) + "\n")
        out.flush()


ENCODINGS = ("plain", "fallback", "marker")


def run_reply(model, item, out):
    by_ref = {m["ref"]: m for m in item["messages"]}
    for enc in ENCODINGS:
        sysmsg = system_prompt(item["messages"], formatter=lambda m, e=enc: encode_reply(m, by_ref, e), reply_note=(enc == "marker")) \
            + " Test format: reply with only the answer (a name or a value), nothing else."
        for q in item["questions"]:
            r = chat(model, [{"role": "system", "content": sysmsg}, {"role": "user", "content": q["q"]}], predict=24)
            ans = r["message"].get("content", "").strip()
            ok = q["expected"].lower() in ans.lower() and not any(f.lower() in ans.lower() for f in q["forbidden"])
            out.write(json.dumps({"bench": "reply", "id": item["id"], "kind": item["kind"], "encoding": enc, "distance": item["distance"],
                                  "qtype": q["answer"], "pass": ok, "answer": ans[:60], "expected": q["expected"],
                                  "wall": round(r["_wall"], 2)}) + "\n")
            out.flush()


def mock_tool(item, name, args):
    args = args if isinstance(args, dict) else {}
    if name == "web_search":
        q = str(args.get("query", "")).lower()
        hits = [p["hit"] for p in item["products"] if p["token"] in q and "hit" in p]
        rest = item["distractors"] if hits else item["distractors"][:2]
        return "\n\n".join(hits + rest + [SNIPPET_NOTE]) if hits + rest else "No results."
    if name == "fetch_url":
        for p in item["products"]:
            if str(args.get("url", "")) == p["url"] and "page" in p:
                return p["page"]
        return "Error: HTTP 404"
    if name == "get_older_messages" and item.get("older"):
        return "\n".join(map(format_msg, item["older"]))
    if name in ("web_search_images", "fetch_pdf"):
        return "Error: no results"
    return f"Error: unknown tool {name}"


def run_tool_item(model, item, out):
    use_older = "get_older_messages" in item["tools"]
    msgs = [{"role": "system", "content": system_prompt(item["room"], use_tools=item["tools"])}, {"role": "user", "content": item["question"]}]
    tools = [TOOL_DEFS[t] for t in item["tools"]]
    calls, final, wall = [], "", 0.0
    for _ in range(MAX_ROUNDS):
        r = chat(model, msgs, tools=tools, predict=200)
        wall += r["_wall"]
        m = r["message"]
        tcs = m.get("tool_calls") or []
        msgs.append({"role": "assistant", "content": m.get("content", ""), **({"tool_calls": tcs} if tcs else {})})
        if not tcs:
            final = m.get("content", "")
            break
        for tc in tcs:
            name, args = tc["function"]["name"], tc["function"].get("arguments", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = {}
            calls.append({"name": name, "args": args})
            msgs.append({"role": "tool", "tool_name": name, "content": mock_tool(item, name, args)})
    up = final.upper()
    cat = item["category"]
    codes = [p["code"] for p in item["products"]]
    final_ok = all(c in up for c in codes) and not any(c in up for c in item["distractor_codes"])
    names = [c["name"] for c in calls]
    tokens = [p["token"] for p in item["products"]]
    queries = " ".join(str(c["args"].get("query", "")).lower() for c in calls if c["name"] == "web_search")
    if cat in ("search", "decoy_tools"):
        tool_ok = bool(names) and names[0] == "web_search"
        args_ok = tool_ok and tokens[0] in queries
    elif cat == "search_fetch":
        tool_ok = "web_search" in names and "fetch_url" in names
        args_ok = tool_ok and any(c["name"] == "fetch_url" and c["args"].get("url") == item["products"][0]["url"] for c in calls)
    elif cat == "restraint":
        tool_ok, args_ok = not names, True
    elif cat == "older":
        older = [c for c in calls if c["name"] == "get_older_messages"]
        tool_ok = bool(older)
        args_ok = tool_ok and all(isinstance(c["args"].get("count"), (int, float)) and not isinstance(c["args"].get("count"), bool) for c in older)
    else:  # two_subjects
        tool_ok = "web_search" in names
        args_ok = tool_ok and all(t in queries for t in tokens)
    out.write(json.dumps({"bench": "tools", "id": item["id"], "category": cat, "tool_ok": tool_ok, "args_ok": args_ok, "final_ok": final_ok,
                          "pass": tool_ok and args_ok and final_ok, "calls": calls, "final": final[:120], "n_calls": len(calls), "wall": round(wall, 2)}) + "\n")
    out.flush()


def load(name):
    return [json.loads(l) for l in open(os.path.join(DATA, name))]


def cmd_gen(args):
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "recall.jsonl"), "w") as f:
        for cell in CELLS:
            for seed in range(args.seeds):
                f.write(json.dumps(gen_recall(seed, cell)) + "\n")
    cats = ["search", "search_fetch", "restraint", "older", "decoy_tools", "two_subjects"]
    with open(os.path.join(DATA, "tools.jsonl"), "w") as f:
        for c in cats:
            for i in range(args.tools_n):
                f.write(json.dumps(gen_tools(c, i)) + "\n")
    with open(os.path.join(DATA, "reply.jsonl"), "w") as f:
        for kind in ("self_attr", "accept"):
            for i in range(args.tools_n):
                f.write(json.dumps(gen_reply(kind, i)) + "\n")
    print("generated", DATA)


def cmd_run(args):
    if not os.path.exists(os.path.join(DATA, "reply.jsonl")):
        cmd_gen(argparse.Namespace(seeds=6, tools_n=30))
    cells = args.cells.split(",")
    which = args.bench.split(",")
    recall = [c for c in load("recall.jsonl") if c["cell"] in cells and c["seed"] < args.seeds] if "recall" in which else []
    tools = [t for t in load("tools.jsonl") if int(t["id"].rsplit("-", 1)[1]) < args.tools_n] if "tools" in which else []
    replies = [t for t in load("reply.jsonl") if int(t["id"].rsplit("-", 1)[1]) < args.tools_n] if "reply" in which else []
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    path = args.out or os.path.join(HERE, "results", f"hard-{args.model.replace('/', '_').replace(':', '_')}.jsonl")
    unload_all()
    start = time.time()
    with open(path, "w") as out:
        for i, c in enumerate(replies, 1):
            run_reply(args.model, c, out)
            if i % 10 == 0:
                print(f"reply {i}/{len(replies)}", flush=True)
        for i, c in enumerate(recall, 1):
            run_recall(args.model, c, out)
            print(f"recall {i}/{len(recall)} {c['id']}", flush=True)
        for i, t in enumerate(tools, 1):
            run_tool_item(args.model, t, out)
            if i % 10 == 0:
                print(f"tools {i}/{len(tools)}", flush=True)
        out.write(json.dumps({"bench": "meta", "model": args.model, "seconds": round(time.time() - start),
                              "truncation_events": truncation_events(start), "loadavg": [round(x, 2) for x in os.getloadavg()]}) + "\n")
    unload_all()
    print("wrote", path)


def wilson(k, n, z=1.96):
    if not n:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    a = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - a) / d, (c + a) / d)


def fmt(rows):
    n = len(rows)
    k = sum(r["pass"] for r in rows)
    lo, hi = wilson(k, n)
    return f"{100 * k / n:3.0f}% ({k}/{n}, CI {100 * lo:.0f}-{100 * hi:.0f})" if n else "-"


def cmd_report(args):
    for path in args.files:
        rows = [json.loads(l) for l in open(path)]
        meta = next((r for r in rows if r["bench"] == "meta"), {})
        rec = [r for r in rows if r["bench"] == "recall"]
        tl = [r for r in rows if r["bench"] == "tools"]
        print(f"\n## {meta.get('model', path)}  ({meta.get('seconds', '?')}s, truncation events: {meta.get('truncation_events')}, load {meta.get('loadavg')})")
        pres = [r for r in rec if r["type"] in ("direct", "decoy", "revision")]
        absn = [r for r in rec if r["type"].startswith("absent")]
        if pres and absn:
            pk, ak = sum(r["pass"] for r in pres) / len(pres), sum(r["pass"] for r in absn) / len(absn)
            print(f"recall present {100 * pk:.0f}%  abstain {100 * ak:.0f}%  balanced accuracy {100 * (pk + ak) / 2:.0f}%")
        if pres:
            ctxs = {c["id"]: {m["ref"]: m["body"] for m in c["messages"]} for c in load("recall.jsonl")}

            def located(r):
                if r["pass"]:
                    return True
                refs = [int(x) for x in re.findall(r"#(\d+)", r["answer"])]
                bodies = ctxs.get(r["id"], {})
                return bool(refs) and any(r["expected"] in bodies.get(x, "") for x in refs)

            print(f"  present recall counting a cited ref that points at the right message: {fmt([{'pass': located(r)} for r in pres])}")
        for label, key in (("type", lambda r: r["type"]), ("length", lambda r: r["cell"]),
                           ("depth", lambda r: None if r["depth"] is None else ("early" if r["depth"] < 1 / 3 else "mid" if r["depth"] < 2 / 3 else "late"))):
            groups = {}
            for r in rec:
                g = key(r)
                if g is not None:
                    groups.setdefault(g, []).append(r)
            print(f"  by {label}: " + "; ".join(f"{g} {fmt(v)}" for g, v in sorted(groups.items())))
        if tl:
            cats = {}
            for r in tl:
                cats.setdefault(r["category"], []).append(r)
            print("  tools: " + "; ".join(f"{c} {fmt(v)}" for c, v in cats.items()))
            print(f"  tools components: tool_ok {fmt([{'pass': r['tool_ok']} for r in tl])}, args_ok {fmt([{'pass': r['args_ok']} for r in tl])}, final_ok {fmt([{'pass': r['final_ok']} for r in tl])}")
        rep = [r for r in rows if r["bench"] == "reply"]
        if rep:
            for enc in ENCODINGS:
                sub = [r for r in rep if r["encoding"] == enc]
                bykind = {k: [r for r in sub if r["kind"] == k] for k in ("self_attr", "accept")}
                near = [r for r in sub if r["distance"] <= 1]
                far = [r for r in sub if r["distance"] > 1]
                print(f"  reply[{enc:8}] all {fmt(sub)}; " + "; ".join(f"{k} {fmt(v)}" for k, v in bykind.items()) + f"; adjacent {fmt(near)}; distant {fmt(far)}")
        toks = {r["cell"]: r["prompt_tokens"] for r in rec if r.get("prompt_tokens")}
        if toks:
            print(f"  cold prompt tokens per cell: {toks}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gen"); g.add_argument("--seeds", type=int, default=6); g.add_argument("--tools-n", type=int, default=30)
    r = sub.add_parser("run"); r.add_argument("model"); r.add_argument("--cells", default="2k,6k,12k"); r.add_argument("--seeds", type=int, default=6)
    r.add_argument("--tools-n", type=int, default=30); r.add_argument("--out"); r.add_argument("--bench", default="reply,recall,tools")
    p = sub.add_parser("report"); p.add_argument("files", nargs="+")
    a = ap.parse_args()
    {"gen": cmd_gen, "run": cmd_run, "report": cmd_report}[a.cmd](a)
