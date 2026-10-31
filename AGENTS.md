# AGENTS.md

Igor is a Manifest V3 Chrome extension: a side-panel chat with a local Ollama model that can read the Element Web room currently open in the active tab. Plain JS ES modules, no build step, no dependencies.

## Layout

- `manifest.json` — permissions, side panel, service worker
- `src/background.js` — opens the side panel on toolbar click
- `src/extract.js` — `extractRoom(limit, since)` and `searchRoom(roomId, query, limit)`; injected into the Element tab with `world: "MAIN"`, so each must stay self-contained (no imports, no shared helpers, no closures over module state)
- `src/panel.{html,css,js}` — chat UI, model picker, Ollama streaming, tool-call loop, web tools

## Conventions

- No inline `<script>` (MV3 CSP), no remote code, no build tooling.
- Comment sparingly; only non-obvious code.
- Render model output by escaping first, then applying the tiny markdown pass (`renderMarkdown`). Never insert raw model or page text as HTML.
- Never commit room contents, tokens, or personal hostnames. Test output from real rooms stays out of the repo.

## Things that will bite you

- Room context uses Element's internal `window.mxMatrixClientPeg`; it may change between Element versions. History is fetched via `createMessagesRequest` because the live timeline can be a short window with no back token.
- Ollama must allow extension origins (`OLLAMA_ORIGINS=chrome-extension://*`), otherwise requests get 403.
- Chat requests send `think: false`, `options.temperature: 0` and an explicit `options.num_ctx`; without `num_ctx` Ollama silently truncates long room dumps, and at gemma4's default temperature (1) the same request sometimes comes back wrong (e.g. a window with messages reported as empty).
- DuckDuckGo blocks extension-originated requests (202/403 bot check); web search uses Brave's HTML results. A blocked search must return an error to the model, never an empty result.
- Models without tool support error with "does not support tools"; the loop retries without tools.
- Element advances `m.fully_read` seconds after a room is shown, so the Unread button uses the marker the panel saw when the room first appeared (`seen` in `panel.js`).
- Cached part summaries (`part:<sha256>` keys in `chrome.storage.local`) store `#{$eventId}` instead of `[#N]`: ref numbers only live as long as the room's chat.
- Chats are per room (`chat:<roomId>` in `chrome.storage.session`: memory only, wiped by a browser restart or an extension reload), and so are `[#N]` refs. `getRoom` does not register refs; callers do, after checking the room is the chat's. A room switch during a streaming answer is deferred until it ends.
- Server-side search (`client.search`) silently returns nothing for encrypted rooms, so `searchRoom` branches on the `m.room.encryption` state event, not on empty results, and pages encrypted history itself.

## Testing

No unit-test harness yet. Manual loop:

1. Branded Chrome 137+ ignores `--load-extension`, and 136+ ignores `--remote-debugging-port` on the default profile (devtools `--autoConnect` then 403s or opens its own blank browser). Use a dedicated profile with `--remote-debugging-port=9223 --user-data-dir=<dir>`, log in to Element there manually, then Load unpacked from `chrome://extensions` and drive it over CDP on that port.
2. The side panel can't be driven over CDP. Open `chrome-extension://<id>/src/panel.html?tab=<element-tab-id>` as a normal tab; the `?tab=` override makes the panel target that tab. Get the tab id via `chrome.tabs.query` from the extension service worker.
3. `extractRoom` can be run in the Element page via `Runtime.evaluate` (strip the `export`). Check message counts and ordering, not bodies.
4. Syntax check: `node --check --input-type=module < src/panel.js`.
