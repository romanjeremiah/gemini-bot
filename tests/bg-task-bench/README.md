# Background-task benchmark

Benches 25 models × 10 background tasks × 5 scenarios = **1250 trials** to inform the cascade re-architecture.

## What it tests

10 production prompts mirrored from real code paths:

| # | Task | Production file |
|---|---|---|
| 1 | Conversation mode classifier | `src/services/cfAi.js` `tagConversationMode` |
| 2 | Triple extraction (KG SPO) | `src/services/cfAi.js` `extractObservation` |
| 3 | Mood entry clinical tagging | `src/services/cfAi.js` `tagMoodEntry` |
| 4 | Memory deduplication | `src/services/cfAi.js` `deduplicateMemories` |
| 5 | Style card consolidation | `src/services/cfAi.js` `consolidateStyleCard` |
| 6 | Mood score micro-ack | `src/services/moodMicroAck.js` `runScoreAck` |
| 7 | Mood emotions micro-ack | `src/services/moodMicroAck.js` `runEmotionsAck` |
| 8 | Mood synthesis (end-of-flow) | `src/services/moodSynthesis.js` |
| 9 | Persona evolution observations | `src/services/personaEvolution.js` |
| 10 | Response curator (JSON) | `src/services/responseCurator.js` |

Tasks 6, 7, 8 use the full Xaridotis persona (~18 KB system prompt) to reflect production input sizes.

## Models

**16 Cloudflare Workers AI** (catalogue current 2026-05-15, deprecated models excluded):

`kimi-k2.6` · `glm-4.7-flash` · `gpt-oss-120b` · `gpt-oss-20b` · `llama-4-scout-17b` · `gemma-4-26b` · `nemotron-3-120b` · `granite-4.0-h-micro` · `qwen3-30b-a3b-fp8` · `mistral-small-3.1-24b` · `qwq-32b` · `qwen2.5-coder-32b` · `deepseek-r1-distill-32b` · `llama-3.3-70b-fp8-fast` · `llama-3.2-3b` · `llama-3.1-8b-fp8`

**9 Gemini variants** (paid Tier 1):

`gemini-3-flash` · `gemini-3.1-fl` (default / +minimal / +medium) · `gemini-2.5-fl` (+dyn / +b512) · `gemini-2.5-pro` (+dyn / +b128) · `gemini-3.1-pro`

## Running

```bash
# From repo root — substitute your real keys for <PLACEHOLDERS>
GEMINI_API_KEY='<your_gemini_api_key>' \
CLOUDFLARE_API_TOKEN='<your_cf_workers_ai_token>' \
CLOUDFLARE_ACCOUNT_ID=bc6018c200086c59663c8ff798e689fa \
node tests/bg-task-bench/run.js
```

> ⚠️ Use single quotes around the values. Do NOT paste the angle-bracket placeholders literally — the shell will treat `<...>` as redirection or the literal string and every call will fail with `API_KEY_INVALID`.

Estimated runtime at concurrency 5: **60-90 min**. Estimated cost £3-£6 (dominated by 2.5 Pro variants on synthesis + curator).

### Flags

| Flag | Purpose |
|---|---|
| `--task=mode_classifier` | Run only one task |
| `--model=cf:kimi-k2.6` | Run only one model |
| `--concurrency=10` | Bump concurrency (default 5) |
| `--skip-gemini` | CF-only run (~15 min) |
| `--skip-cf` | Gemini-only run (~30 min) |
| `--dry-run` | List planned trials, no API calls |

### Smoke test before full run

```bash
# Run just one task on two models to sanity-check setup
GEMINI_API_KEY='<your_key>' node tests/bg-task-bench/run.js --task=mode_classifier --model=gem:flash-3
CLOUDFLARE_API_TOKEN='<your_token>' CLOUDFLARE_ACCOUNT_ID=bc6018c200086c59663c8ff798e689fa \
  node tests/bg-task-bench/run.js --task=mode_classifier --model=cf:kimi-k2.6 --skip-gemini
```

## Output

`tests/bg-task-bench/results/<timestamp>/`
- `trials.csv` — one row per trial: model, task, scenario, latency_ms, api_ok, parse_ok, output_preview, parsed_value, validate_notes, error
- `summary.md` — per-task model rankings (parse % then P95 latency), per-model overview, top-3 picks per task

## How `parse_ok` is defined per task

| Task | Pass criterion |
|---|---|
| mode_classifier | Output contains one of `venting / processing / transactional / crisis` |
| triple_extraction | Has `OBSERVATION:` or `TRIPLE:` lines when scenario expects new info, else `NOTHING_NEW` |
| mood_tagging | 1-3 comma-separated tags, all from the allowed clinical set |
| memory_dedup | Output contains `DUPLICATES:`, `CONTRADICTIONS:` or `GROUP:` markers |
| style_card | 100-4000 chars, has `##` or `-` structure, not wrapped in code fence |
| mood_score_ack | 30-600 chars, prose (no JSON / no code fence), ends with terminal punctuation |
| mood_emotions_ack | 30-800 chars, prose (no JSON / no code fence), ends with terminal punctuation |
| mood_synthesis | 100-3000 chars, **no off-today emotions mentioned** (anti-hallucination anchor) |
| persona_evolution | Has `COMMUNICATION_NOTES:` or `EVOLVED_TRAITS:` headers with bullets, or `NONE` |
| curator | Parses as valid JSON with `register`, `flags[]`, `relevant_memory_ids[]`, `reasoning` |

## Re-running just the failures

After a run, filter the CSV to find which (model, task) pairs scored badly:

```bash
# Example: see all failures from last run
awk -F, '$8=="false"' tests/bg-task-bench/results/<stamp>/trials.csv
```

Then re-run that pair specifically with `--model` and `--task`.

## Adding a new task

Edit `tasks.js`:
1. Define `MY_TASK = { id, name, sys, maxOutputTokens, requiresPersona, scenarios, validate }`
2. Add a case to the `buildInput` switch
3. Append to the `TASKS` array export

## Adding a new model

Edit `models.js`:
1. Add `{ id, kind: 'gemini'|'cf', model: 'binding-string', opts?: {...}, label }` to the `MODELS` array
2. Re-run; existing CSVs are untouched

## Notes / caveats

- Temperature is locked at 1.0 across all calls to match production.
- Gemini latency includes any thinking tokens; CF latency is wall-clock from request to first response.
- CF responses are inconsistent in shape (some `{result: "..."}`, some `{result: {response: "..."}}`); the runner handles both. If a model returns something genuinely unparseable, that shows up in `output_preview`.
- Scenarios for mood-related tasks use realistic clinical content. The validator for `mood_synthesis` checks the "today-only emotions" anchor that was added after the live-test hallucination.
- Cost dominated by `gemini-2.5-pro-*` variants and `gemini-3.1-pro` on persona-heavy tasks. Use `--skip-gemini --task=...` for cheap CF-only sweeps while iterating.
