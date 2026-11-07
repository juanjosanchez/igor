# AGENTS.md

Igor is a Manifest V3 Chrome extension: a side-panel chat with a local Ollama model that can read the Element Web room currently open in the active tab. Plain JS ES modules, no build step, no dependencies.

## Layout

- `manifest.json` — permissions, side panel, service worker
- `src/background.js` — opens the side panel on toolbar click
- `src/extract.js` — `extractRoom(limit, since)` and `searchRoom(roomId, query, limit)`; injected into the Element tab with `world: "MAIN"`, so each must stay self-contained (no imports, no shared helpers, no closures over module state)
- `src/panel.{html,css,js}` — chat UI, model picker, Ollama streaming, tool-call loop, web tools
- `tests/` — Node tests for the injected functions, and a browser harness that runs the real panel against fakes

## Conventions

- No inline `<script>` (MV3 CSP), no remote code, no build tooling.
- Comment sparingly; only non-obvious code.
- Render model output by escaping first, then applying the tiny markdown pass (`renderMarkdown`: code, headings, lists, bold, italics). Never insert raw model or page text as HTML, and never turn a URL the model wrote into a link: one click would send whatever the model put in it.
- Never commit room contents, tokens, or personal hostnames. Test output from real rooms stays out of the repo.

## Things that will bite you

- Room context uses Element's internal `window.mxMatrixClientPeg`; it may change between Element versions. History is fetched via `createMessagesRequest` because the live timeline can be a short window with no back token.
- Ollama must allow Igor's origin (`OLLAMA_ORIGINS=chrome-extension://<id>`), otherwise requests get 403. An unpacked extension's ID comes from its folder path. Never recommend `chrome-extension://*`: it lets every installed extension use Ollama's API, including deleting and pulling models.
- Chat requests send `think: false`, `options.temperature: 0` and an explicit `options.num_ctx`; without `num_ctx` Ollama silently truncates long room dumps, and at gemma4's default temperature (1) the same request sometimes comes back wrong (e.g. a window with messages reported as empty).
- Even with `num_ctx`, a request that does not fit gets no error: Ollama keeps only its end (a 15.5k-token prompt at `num_ctx` 4096 was read as 2,051 tokens, and the model answered from that). `streamChat` flags a request whose `prompt_eval_count` is far below the characters sent, and `ask` shows a warning. The room budget assumes 2.5 characters per token; gemma4 measured 2.4-2.9 on chat lines.
- `web_search` results end with `SNIPPET_NOTE`, which tells the model to open a page when the snippets lack the answer; without it gemma4 never fetched. `benchmarks/hard.py` mirrors it.
- DuckDuckGo blocks extension-originated requests (202/403 bot check); web search uses Brave's HTML results. A blocked search must return an error to the model, never an empty result.
- Models without tool support error with "does not support tools"; the loop retries without tools.
- Ollama reuses its work only on the part of a request that matches the previous one from the start, so whatever changes between questions goes at the end. The clock is the last thing in the system prompt: with it first, a question one minute later re-read a whole 8.4k-token room (7.15 s) instead of reusing it (0.27 s). `benchmarks/hard.py` mirrors the order.
- Plain questions see an anchored room window (`roomWindow`, `chat.anchor`): it starts at the same message as the previous question and new messages are appended, so the request start stays the same. A new anchor takes 3/4 of the message and character limits to leave room to grow, and the header has no message count. A reply marker shows `[#N]` only when that message is in the window. `get_older_messages` continues right before the window's first message.
- Picking another model in the dropdown unloads the previous one (`unloadModel`, only if `/api/ps` lists it, and not mid-answer); with `keep_alive` both would stay loaded.
- Chat requests also send `keep_alive` (Settings, default 30 minutes; Ollama's own is 5): an unloaded model costs a reload and loses the reusable work.
- Plain questions reuse the previous load of the room (`loadRecent`): `extractRoom`'s `after` fetches only events newer than the last message kept, starting with a page of 20, and reports redactions among them so deleted messages are dropped; a full reload happens at least every 15 minutes. The status bar uses `getRoom(0)`, which pages no history, and `tabs.onUpdated` fires for every tab in every window, so it checks the tab is the one the panel reads. The stats line shows the room loading time. `get_older_messages` cuts by time (`ctx.before`), not by count, because messages can arrive mid-answer.
- Element advances `m.fully_read` seconds after a room is shown, so the Unread button uses the marker the panel saw when the room first appeared (`seen` in `panel.js`).
- Cached part summaries (`part:<sha256>` keys in `chrome.storage.local`, or in `chrome.storage.session` for encrypted rooms and when `partDays` is 0, since local storage is plain text on disk; local ones are pruned `partDays` days after their last use) store `#{$eventId}` instead of `[#N]`: ref numbers only live as long as the room's chat.
- Chats are per room (`chat:<roomId>` in `chrome.storage.session`: memory only, wiped by a browser restart or an extension reload), and so are `[#N]` refs. `getRoom` does not register refs; callers do, after checking the room is the chat's. A room switch during a streaming answer is deferred until it ends.
- Room messages and fetched pages are untrusted text in the model's context. `fetch_url` only opens links that appear in the user's messages, the room messages given to the model or search result links (`chat.urls`), never one the model wrote itself, so injected text cannot send room contents out in a URL. Tool outputs that echo the model's arguments (e.g. `search_room`'s header) must not feed `chat.urls`. Pages are fetched without cookies. `fetch_url` also refuses addresses on this computer or a private network (`isLocalUrl`), even ones the user typed, and drops a page that redirected to one; fetch follows redirects itself, so that request has already gone out.
- `trimWebResult` cuts each answer's web tool results in the chat history once the next answer is done (`chat.pending`, by history index): a fetched page becomes a note with its URL, search results keep only titles and links. Pages are untrusted and would otherwise steer every later answer in that chat, and a few of them filled the context window. Cutting right after the answer broke follow-ups: gemma4 26b reopened the page for only 1 of 6 follow-up questions with a rule in the system prompt, and 2 of 3 with the note alone, otherwise saying the page lacked the answer or guessing. Room tool results stay, like the room window. The panel log is separate and keeps everything shown.
- `fetchUrl` marks where blocks end before taking `textContent`: line breaks before and after `BLOCKS`, "- " before list items, a space after table cells, and only non-newline whitespace is collapsed. Minified HTML otherwise ran blocks together ("Release 4.2Builds are 20% faster"), and gemma4 answered a page's heading when asked for its first list item.
- `web_search` queries go to Brave, a third party, and the model writes them, so a steered model could paste room messages into one. Queries over `MAX_QUERY` (150) characters and searches beyond `MAX_SEARCHES` (5) per answer are refused with an error to the model.
- Server-side search (`client.search`) silently returns nothing for encrypted rooms, so `searchRoom` branches on the `m.room.encryption` state event, not on empty results, and pages encrypted history itself.

## Testing

- `node tests/extract.test.mjs` and `node tests/search.test.mjs` run `extractRoom` and `searchRoom` against a fake Matrix client (pass a path to test another copy of `extract.js`).
- `python3 tests/harness/serve.py [port]` serves `src/` with `tests/harness/stub.js` injected into `panel.html`: fake `chrome.*` APIs (`storage.session` survives a reload, like a panel reopen), a fake Element client with an unencrypted room (server search) and an encrypted one (`!enc:example.org`), and a fake Ollama that answers with what it was given. Some questions script it: `search <words>`, `fetch <url>`, `web <query>` (search, then open the first result), `open the room link`, `leak` (builds a URL out of room messages, as injected text would), `markdown` (an answer with every formatting case) and `overflow` (reports the token count of a cut request); `__fetched` lists the pages opened. `__post(body)` adds a message to the unencrypted room, `__redact(id)` deletes one, and `__tabUpdated(id, change)` fires a tab update for any tab id. Open `http://localhost:8765/src/panel.html` and drive the real panel; `__switchRoom(id)` moves the fake tab, `__chats` holds the requests sent to Ollama. It checks plumbing, not answer quality.

Against real Element, manually:

1. Branded Chrome 137+ ignores `--load-extension`, and 136+ ignores `--remote-debugging-port` on the default profile (devtools `--autoConnect` then 403s or opens its own blank browser). Use a dedicated profile with `--remote-debugging-port=9223 --user-data-dir=<dir>`, log in to Element there manually, then Load unpacked from `chrome://extensions` and drive it over CDP on that port.
2. The side panel can't be driven over CDP. Open `chrome-extension://<id>/src/panel.html?tab=<element-tab-id>` as a normal tab; the `?tab=` override makes the panel target that tab. Get the tab id via `chrome.tabs.query` from the extension service worker.
3. `extractRoom` can be run in the Element page via `Runtime.evaluate` (strip the `export`). Check message counts and ordering, not bodies.
4. Syntax check: `node --check --input-type=module < src/panel.js`.
