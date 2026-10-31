# Igor

Chrome side panel for Element Web: a chat with a local Ollama model that sees the room you have open.

## Installation

Requirements: Chrome (or a Chromium browser with side panel support), [Ollama](https://ollama.com) running locally with at least one model pulled, and an Element Web account. No build step or dependencies.

1. Get the code:
   ```sh
   git clone https://github.com/pmatos/igor.git
   ```
2. Pull a model if you have none, for example `ollama pull gemma4:12b`. Pick one that supports tools if you want web search; others fall back to plain chat.
3. Let Ollama accept requests from the extension, otherwise it answers 403. Set `OLLAMA_ORIGINS=chrome-extension://*` and restart it:
   - systemd user service: `systemctl --user edit ollama`, add `[Service]` and `Environment=OLLAMA_ORIGINS=chrome-extension://*`, then `systemctl --user restart ollama`
   - manual: `OLLAMA_ORIGINS='chrome-extension://*' ollama serve`
4. Load the extension: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select the cloned `igor` directory. Command-line flags like `--load-extension` are ignored by recent branded Chrome, so use this UI.
5. Open Element Web in a tab and click the Igor toolbar icon. The panel docks beside the page. Choose a model in the dropdown; the room you have open is picked up automatically.

Updating: `git pull`, then click the reload icon on the Igor card in `chrome://extensions`.

Ollama is expected at `http://localhost:11434`; change it under **Settings** in the panel. The extension requests `https://*/*` host access so it works on any Element host and `fetch_url` can read pages; narrow `host_permissions` in `manifest.json` if you only use one host.

First questions in a long room can be slow on modest hardware because the whole context is processed. Lower **Max room messages** in Settings, or use a smaller or MoE model.

## Usage

- **Room context** checkbox (under the input, like **Web tools**; both only affect typed questions): include recent messages of the open room in each question.
- **Web tools** checkbox: let the model search the web and fetch pages. The room tools (older messages, room search) are offered whenever room context is on.
- **Search** next to **Send**: lists the room's messages that contain all the typed words, as `#N` links, without asking the model. Unencrypted rooms are searched by the homeserver across the whole history; encrypted rooms over the newest 3000 events. The results stay in the chat, so a follow-up question can use them. The model can also search on its own (`search_room`, below).
- **Quick buttons** above the input (always use the open room, regardless of the Room context checkbox):
  - **Unread**: what you missed since your read marker. Element moves the marker seconds after you open a room, so the panel remembers where it was when it first saw the room; keep the panel open while switching rooms.
  - **Day / Week / Month**: summary of the last 24 hours, 7 days or 30 days (week and month start at midnight).
  - **Mentions**: messages from the last 7 days that ask you something or need your reply. Only messages that mention you (name, user id, `@room`), reply to you, or come from the other person in a direct chat are considered.
  - Windowed buttons load the whole period regardless of **Max room messages**. When it does not fit the context window, each calendar week (or day) is handled separately and the answer is built from those notes; this is slow for a busy month on modest hardware, and **Stop** works. Notes for finished weeks are cached in extension storage for 60 days, so repeating a month summary only redoes the recent part. **Forget cached part summaries** in Settings clears them. If the start of the period cannot be loaded, the panel says where coverage begins.
  - Edit the buttons in **Settings**, one per line: `label | period | prompt`, where period is empty (recent messages, like a normal question), `unread`, or days like `14d`, optionally with `mentions`; `{period}` in the prompt becomes the time span. Empty the box to restore the defaults.
- **Copy** under an answer copies it as Markdown, with `#12` citations turned into message links.
- **Message links**: answers cite room messages as `#12` links with a hover tooltip (sender, time). Clicking one jumps the Element tab to that message, so you can ask for a summary and read the parts that matter.
- **One chat per room**: switching rooms in Element switches the conversation, and coming back to a room (even after closing the panel) brings its chat back. Chats are kept in memory only (`chrome.storage.session`) and are gone after a browser restart or when the extension is reloaded or updated. While an answer is streaming the panel stays on its room and switches when it ends.
- **Clear** empties the current room's chat (and stops an answer in progress).

## How it works

- Room context comes from Element's own `window.mxMatrixClientPeg` (matrix-js-sdk client), read via a `world: "MAIN"` script injected on each send. Decrypted events work; no second Matrix login. This is an internal global and may change between Element versions.
- The room is taken from the URL hash (`#/room/...`). Older history is back-paginated up to "Max room messages", or for summaries up to the start of the period (at most 5000 events).
- Replies are encoded as `Name (replying to [#N] Other): ...` (from the Matrix reply relation; the legacy quoted fallback is stripped), because a bare reply body is ambiguous: see `benchmarks/` (reply understanding rose from 73% to 100% for `gemma4:26b-a4b-it-qat`).
- Default model is `gemma4:26b-a4b-it-qat` when installed (falls back to `gemma4:e4b-it-qat`, then the first model); a model you pick in the dropdown stays pinned.
- Model list comes from `GET /api/tags`; chat uses `/api/chat` with streaming, `think: false`, `temperature: 0` (same answer for the same input, as in the benchmarks) and an explicit `num_ctx`.

## Tools

The model can call (toggle "Web tools" in the panel; models without tool support fall back automatically):

- `web_search` — Brave Search HTML results, no API key (DuckDuckGo blocks extension requests)
- `fetch_url` — page text, truncated to 8k chars
- `get_older_messages` — back-paginates the room via the Matrix client for history beyond the initial window
- `search_room` — finds messages containing all the given words. Unencrypted rooms use the homeserver's search index, which covers the whole history; encrypted rooms are not indexed, so the newest 3000 events are paged and matched locally. The result always says how far back it looked, so the model does not mistake "not found in the last month" for "never discussed".

The extension requests `https://*/*` host access so `fetch_url` and Element on any host work.

## Layout

- `src/panel.*` — side panel UI
- `src/extract.js` — room extraction (injected into the page)
- `src/background.js` — opens the panel on icon click

## Benchmarks

Default model choice and raw results live in [`benchmarks/`](benchmarks/README.md), including a plan for harder synthetic tests.
