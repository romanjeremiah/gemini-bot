# RFC: Migrate Background Tasks to Cloudflare Workflows & Queues

## Background
Recent updates to Cloudflare Workers best practices strongly advise using **Queues and Workflows** for asynchronous background tasks. Currently, our architecture relies on standard Cron Triggers for heavy tasks like the Autonomous Research Loop, Weekly Mental Health Report, and Monthly Memory Consolidation.

## Problem
1. **D1 Timeouts**: We have a known limitation where D1 can timeout under heavy concurrent load.
2. **Execution Limits**: Heavy tasks like the Autonomous Research Loop and Memory Consolidation risk hitting Worker execution limits.

## Proposed Solution
1. **Cloudflare Workflows**:
   - Migrate `Monthly Memory Consolidation / REM Sleep` to a Workflow.
   - Migrate `Autonomous Research Loop` to a Workflow.
   - Workflows provide step-by-step execution, automatic retries, and state management, preventing timeouts during heavy LLM/Vectorize operations.
2. **Cloudflare Queues**:
   - Decouple heavy D1 database writes (like batch mood journaling or memory syncing) into a Queue consumer.
   - This will smooth out concurrent load spikes on D1, mitigating the known timeout issue.

## Implementation Steps
1. Add `[[workflows]]` and `[[queues]]` bindings to `wrangler.toml`.
2. Create `src/workflows/` directory for Workflow entrypoints.
3. Shift cron triggers to dispatch Workflow instances instead of running the logic directly in the scheduled handler.