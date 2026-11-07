# Model benchmarks

Which local model should Igor default to? Measured through Ollama (0.40.7, Vulkan) on an AMD Ryzen AI 9 HX 370 / Radeon 890M iGPU laptop, 124 GB shared memory.

`bench.py` sends a synthetic Element-style room (random chat lines with two planted facts) plus three tool-call prompts, and records speed, recall and tool selection. Everything is synthetic; no real room content is used.

```sh
BENCH_LINES=110 BENCH_OUT=results/run.jsonl python3 -I bench.py gemma4:26b-a4b-it-qat SparkLLM/Spark-X2.6-4B:q4_k_m
```

Settings: `num_ctx` 16384, `think: false`, temperature 0, `num_predict` 120. Q1 is a cold prompt (measures prefill); Q2 reuses the prefix (warm). Recall passes when the answer contains the planted fact; tools pass when the expected tool is called.

## Results (`results/2026-10-28-clean-5k.*`)

~5.5k-token prompt, load average 6-8 on 24 cores (one busy core plus a browser), so reasonably clean but not lab-grade.

| Model | Prefill tok/s | Decode tok/s | Cold prompt | Recall | Tools |
|---|---|---|---|---|---|
| `gemma4:e4b-it-qat` | 746 | 22.4 | 11.9 s | 2/2 | 3/3 |
| `SparkLLM/Spark-X2.6-4B:q8_0` | 672 | 14.7 | 11.9 s | 2/2 | 3/3 |
| `SparkLLM/Spark-X2.6-4B:q4_k_m` | 654 | 21.9 | 11.4 s | 2/2 | 3/3 |
| `gemma4:26b-a4b-it-qat` | 639 | 21.2 | 16.3 s | 2/2 | 3/3 |
| `gemma4:12b` | 253 | 8.4 | 28.0 s | 2/2 | 3/3 |

## Earlier gemma4 sweep (`results/2026-10-28-gemma4-sweep.jsonl`)

Speed only. The prompt was ~21k tokens and Ollama truncated it to ~8.2k, dropping the middle, so `qa1_ok` is false for every model and is **not** a quality signal. Speeds are valid for an ~8k-token prompt.

| Model | Prefill tok/s | Decode tok/s | Cold 8k prompt |
|---|---|---|---|
| `gemma4:e4b-it-qat` | 753 | 21.1 | 14.8 s |
| `gemma4:26b-a4b-it-qat` | 633 | 23.3 | 18.8 s |
| `gemma4:26b-a4b-it-q4_K_M` | 561 | 21.1 | 24.6 s |
| `gemma4:26b-a4b-it-mtp-q4_K_M` | 529 | 20.3 | 26.2 s |
| `gemma4:12b-it-qat` | 285 | 8.3 | 35.6 s |
| `gemma4:12b` | 256 | 9.1 | 38.7 s |
| `gemma4:31b-it-qat` | - | - | crashed (Vulkan `ErrorDeviceLost`) |

Takeaways: MoE `26b-a4b` is ~2.5x faster than dense `12b`; the `mtp` variant gives no gain; dense `31b` is not usable on this iGPU; Spark `q8_0` decodes a third slower than `q4_k_m` with no quality gain on these tests.

## Limits of the current benchmark

Both candidates score 100% on recall and tools, so it cannot separate them on quality: only speed differs. The prompt is also shorter than a real room (~10k tokens).

## Next: synthetic benchmarks that can separate the models

Generate rooms from a structured event list so ground truth is known, seed everything, and score deterministically (substring/set match) rather than with an LLM judge.

1. **Needle recall grid:** 5-10 facts at depths 5-95% across 2k/6k/12k-token contexts, with near-duplicate distractors (a decision that is later revised; the latest must win). Output a depth x length recall heatmap.
2. **Aggregation and multi-hop:** "who mentioned X most", "which tickets did A raise that B answered", counts by day. Ground truth is computed from the generator.
3. **Summary faithfulness:** render a scripted sequence of events as chat, ask for a summary, score a checklist of required events and count claims not in the event list (hallucination rate).
4. **Absent-fact abstention:** questions whose answer is not in the room; the right output is "not in the messages". Measures confident guessing.
5. **Citation accuracy:** Igor cites messages as `#id`; check that each cited id actually contains the claimed content.
6. **Tool use depth:** mock tool backend with canned results; score call sequences (search then fetch then answer), argument exactness (query/URL/count), not calling a tool when the context already has the answer, wrong-tool distractors, parallel calls, numeric arguments.
7. **Performance curves:** prefill, decode and time-to-first-token at 2k/4k/8k/16k/32k context, thinking on vs off (Spark has none/low/high), warm vs cold.

Statistical hygiene: at least 30 items per category with confidence intervals, interleave models (ABAB) to cancel thermal and load drift, repeat speed runs and report mean and spread, and record the load average at start and end of every run. Truncation happens when a prompt exceeds `num_ctx` (observed: a 21k-token prompt at `num_ctx` 16384 was cut to ~8k, dropping the middle), so keep prompt + output under `num_ctx` and check the Ollama journal for `truncating input prompt` after each run.

## Harder benchmarks (`hard.py`)

Implements the plan above for needle recall, abstention and tool use, plus reply understanding. Datasets are generated deterministically (`python3 -I hard.py gen`) and stored in `datasets/`; scoring is exact matching, reported with Wilson 95% intervals. The system prompt, message format and tool loop mirror `src/panel.js`; `num_ctx` is 24576 for every cell.

```sh
python3 -I hard.py run gemma4:26b-a4b-it-qat            # reply, recall, tools (about 35 min per model)
python3 -I hard.py run <model> --bench reply --tools-n 30
python3 -I hard.py report results/hard-*.jsonl
```

- **recall:** 11 questions per synthetic room at 3 lengths (roughly 3k, 9k and 17k tokens; exact counts are recorded per run) and 6 seeds each. Types: direct lookup with paraphrased questions, revisions (the latest value must win), same-attribute decoys for other projects, and abstention (`NOT_FOUND`) for near-miss and fully absent facts. Answer values (`SPICE-NN`) never occur in the filler. Reported: present recall, abstention, balanced accuracy, by depth, length and type.
- **tools:** mock backend; categories `search`, `search_fetch` (must fetch the URL, the snippet lacks the fact), `restraint` (answer already in context: no call), `older` (`get_older_messages` with a numeric count), `decoy_tools` (similarly named extra tools), `two_subjects`. Pass requires the right tool, right arguments and a correct final answer.
- **reply:** who said what when a message replies to another. Each scenario is rendered under three encodings: `plain` (what Igor sent until now: the reply body alone), `fallback` (legacy quoted prefix) and `marker` (`X (replying to [#N] Y)`), which separates model comprehension from how replies are encoded in the context. Types: `self_attr` (a first-person reply to someone's remark, a real failure seen with some models) and `accept` ("fine by me" replying to one of two competing proposals).

### Results (`results/hard-*.jsonl`, 2026-10-28)

`gemma4:26b-a4b-it-qat` vs `SparkLLM/Spark-X2.6-4B:q4_k_m`. 95% Wilson intervals are in `python3 -I hard.py report`. The machine was loaded (load average 11-14 on 24 cores), which affects time but not accuracy. Reply and gemma tools come from the first run; recall (and Spark tools) were re-run after fixing the answer-format sentence and a mock-backend crash (see the `note` field in each file).

**Reply understanding** (120 questions per encoding; `accept` = "fine by me" replying to one of two proposals):

| Encoding | gemma4 26b | Spark 4B |
|---|---|---|
| `plain` (reply body only) | 73% (`accept` 47%, distant replies 59%) | 50% |
| `fallback` (legacy quote prefix) | 99% | 64% |
| `marker` (`X (replying to [#N] Y)`) | 100% | 62% |

The first-person case (`self_attr`, the "I suffer from FOMO" example) is fine for gemma even in plain form (100%) and weaker for Spark (70% plain, 77% with the marker). The big encoding effect is on replies whose referent is not adjacent. Encoding replies explicitly takes gemma from 73% to 100%; Spark gains little.

**Recall / abstention** (126 present-fact and 72 absent questions, rooms of about 3k, 9k and 17k tokens):

| | gemma4 26b | Spark 4B |
|---|---|---|
| present recall (strict: value in the answer) | 81% | 8% |
| ...also counting a cited `[#N]` that points at the right message | 84% | 52% |
| abstention (`NOT_FOUND` when absent) | 92% | 40% |
| balanced accuracy | 86% | 24% |

Spark mostly answers with a bare `[#N]` reference (Igor's prompt tells it to cite messages), so strict scoring understates it; even counting those it locates the right message about half as often as gemma. It also misses paraphrases ("pager schedule" vs "on-call rotation") and rarely abstains. Revisions (latest value must win) are the hardest type for gemma too (58%).

**Tool use** (30 mock cases per category; pass = right tool, right arguments, correct final answer):

| Category | gemma4 26b | Spark 4B |
|---|---|---|
| `search` | 100% | 100% |
| `search_fetch` (must fetch the page, the snippet lacks the fact) | 0% | 90% |
| `restraint` (answer already in context: no tool call) | 100% | 13% |
| `older` (`get_older_messages`, numeric count) | 100% | 100% |
| `decoy_tools` | 100% | 100% |
| `two_subjects` | 100% | 100% |

gemma stops after the search snippet and never fetches the page; Spark fetches but calls tools even when the answer is already in the room (87% of `restraint` cases).

**Takeaway:** gemma4 26b is the better default for answering questions about a room. Spark is fast and handles tool calls, but it is much weaker at recall, abstention and replies.

### Opening pages after a search (`results/2026-11-07-tools-*.jsonl`)

Measured on an Apple M5 Pro (64 GB, Ollama 0.40.13, Metal) with the machine busy (load average 10-31), which affects time but not accuracy.

Before this change, `web_search` returned only the results, and gemma4 26b answered from the snippets: it never opened a page (0/30 in `search_fetch`, the same as on the AMD laptop above). Now the results end with one sentence (`SNIPPET_NOTE` in `src/panel.js`, mirrored in `hard.py`): the snippets may not hold the answer, so open the most relevant result first. `gemma4:31b-it-qat` ran 10 cases per category (`--tools-n 10`) because it is about 6 times slower.

| Category | 26b before | 26b after | 31b before | 31b after |
|---|---|---|---|---|
| `search` | 100% | 100% | 100% | 100% |
| `search_fetch` | 0% (0/30) | 83% (25/30) | 100% (10/10) | 100% (10/10) |
| `restraint` | 100% | 100% | 90% (9/10) | 90% (9/10) |
| `older`, `decoy_tools`, `two_subjects` | 100% | 100% | 100% | 100% |

Of the 5 remaining 26b `search_fetch` failures, 4 still answered from the snippets and 1 opened a distractor's page; all 5 said they could not find the codename instead of guessing. The 31b already opened pages without the sentence, and it does not hurt it. Its `restraint` miss is the same case in both runs: no tool call, but an empty answer.

### Clock last and a fixed room window (`results/2026-11-07-recall-reply-26b-*.jsonl`)

Same Mac, quiet this time (load average 1.5-2.9). Ollama reuses its work only on the part of a request that matches the previous one from the start. Before this change Igor's system prompt began with the current time and its room header gave the message count, so every question asked in a new minute, or after a new message, re-read the whole room. Now the time comes last and the header has no count; `hard.py` mirrors both. Recall and reply understanding with `gemma4:26b-a4b-it-qat`:

| | Before | After |
|---|---|---|
| present recall (strict) | 79% | 81% |
| ...also counting a cited `[#N]` | 82% | 82% |
| abstention | 93% | 94% |
| `revision` (latest value must win) | 53% | 58% |
| replies, `plain` / `fallback` / `marker` | 73% / 99% / 100% | 75% / 99% / 100% |

All differences are within the 95% intervals, so the reordering does not hurt answers. In Igor itself, with the real model and the test harness room, follow-up questions reused about 6,800 of 7,200 tokens and showed their first word after 0.5-0.9 s; the previous version re-read the whole room every time (9,300 tokens, 9.7-10.3 s).
