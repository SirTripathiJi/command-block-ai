# Test Results — AI Harness `11`

Audit date: 2026-09-27 (Asia/Kolkata)

## Final verification

| Command | Result | Evidence |
| --- | --- | --- |
| `make setup` | PASS, exit 0 | `npm install --no-audit --no-fund`; output: `up to date in 202ms`. |
| `make test` (final run, after the test additions) | PASS with skips, exit 0 | **104 cases total: 102 passed, 0 failed, 2 skipped**, 0 cancelled, 0 todo; 710 ms. |
| `make run` with valid issue and only `AI_API_KEY` set to a harmless audit placeholder | Expected configuration failure, exit 2 from `make` | CLI printed `outcome: configuration_error`, `code: provider_not_configured`, and instructions to set `LLM_PROVIDER`; no stack trace and no API request. This reproduces the official key-only workflow supplied for this audit. |
| `npm run test:evaluation` (after test additions) | PASS, exit 0 | Clean-copy simulation passed setup, deterministic tests, structured configuration error/redaction check, and cleanup. |

The setup, test, and run commands were invoked in the requested order. The CLI run tested startup with the official instructions' only explicit setting (`AI_API_KEY`) and then the missing-provider path. The supplied organizer instructions specify DeepSeek and Qwen families, but exact model IDs and whether the evaluator injects `LLM_PROVIDER`, `LLM_MODEL`, and `LLM_ENDPOINT` are still unclear. A harmless placeholder was used, not a real credential; no live API request was attempted.

## Live tests skipped

The normal test command includes two opt-in tests in `tests/integration/liveProvider.test.js`. Both were skipped, with the runner's explicit reasons:

- `live provider smoke test returns the exact requested text` — requires `RUN_LIVE_LLM_TESTS=1` plus a real `AI_API_KEY` and `LLM_PROVIDER`.
- `live end-to-end workflow modifies an isolated fixture and verifies it` — requires `RUN_LIVE_LLM_E2E=1` plus a real `AI_API_KEY` and `LLM_PROVIDER`.

They are **not passes**. The first verifies a live text response; the second attempts a real fixture edit, tests, review, and verification in a temporary Git repository. Both remain unverified until run with the organizer-approved model and credentials.

## Test areas and case records

The 104 test cases are actual Node `node:test` tests, not placeholder assertions. Each title below is a test ID in the runner output; the corresponding test body in the cited file constructs input/fixtures and asserts expected behavior. For executed cases, actual result was PASS unless marked SKIP above. Failed cases: none in the final run.

| Test file | Test IDs / behaviors covered | Final result |
| --- | --- | --- |
| `tests/core/agentLoop.test.js` | Multiple tool calls, unknown tool/failure/final answer; bounded agent-loop step count; multi-call ordering and tool-call ID preservation. | PASS |
| `tests/core/core.test.js` | Config defaults and bounds; missing API key and redaction; TaskState serialization; outcome states; provider setup errors; malformed planning; partial failure; evidence-based final verification; registries; schema and response validation. | PASS |
| `tests/core/executionEngine.test.js` | Dependency scheduling, concurrency, stable ordering, blocked branches, timeout release, and multi-parent dependencies. | PASS |
| `tests/core/llmRuntime.test.js` | Provider contract, transient retry limits, timeout abort, malformed request/response rejection, credential/prompt redaction. | PASS |
| `tests/core/openaiCompatibleProvider.test.js` | OpenAI-compatible request formatting, tool calls, provider error categories/retries, timeout, malformed/oversized responses, provider selection/config, custom adapters, and 21 additional endpoint/request/response boundary tests added during this audit. | PASS |
| `tests/core/phase10.test.js` | Invalid inputs, CLI EOF, plan revalidation, resource limits, no-code workflow, idempotency, evidence requirements, unexpected changes, and task-state privacy. | PASS |
| `tests/core/planner.test.js` | Agent/tool discovery, plan validation, dependency ordering, unavailable specialist, retries, context selection, API routing, and result contracts. | PASS |
| `tests/integration/liveProvider.test.js` | Live text smoke and isolated live end-to-end coding workflow. | SKIP, SKIP (external credentials/model unavailable; intentionally opt-in) |
| `tests/integration/phase3.test.js`, `phase5.test.js` | Mock-driven edit/test/recovery/review, API Specialist evidence/routing/read-only restrictions, and malformed output handling. | PASS |
| `tests/tools/tools.test.js` | Workspace traversal/symlink containment, search, fixed read-only Git calls, command allowlist, shell-disabled execution. | PASS |

The runner's authoritative final count is **104 / 102 pass / 0 fail / 2 skip**. The table summarizes related tests by file rather than pretending every test in a file had the same input.

## Audit test additions and first-run correction

I added 21 focused adapter tests in `tests/core/openaiCompatibleProvider.test.js` to improve coverage of missing/invalid configuration, endpoint construction, malformed requests, generation options, refusals, duplicate tool IDs, HTTP 403/408, and function-schema mapping. The first run of the expanded suite had one failing test because its new HTTP 408 assertion expected `provider_timeout` after exhausting a zero-retry budget; the actual LLM client intentionally normalizes exhausted transient errors to `llm_retry_exhausted`. I corrected the test to verify the intended retry behavior (one 408 followed by success within a one-retry budget), then reran the full suite. No application behavior was changed to make the test pass.

## Not run / limits

- No live provider or live end-to-end test: no prescribed model/organizer endpoint/key was supplied. Never paste a real key into reports or source.
- No actual Git status/history can be assessed: this Desktop folder has no `.git` directory. The live E2E test would create a temporary Git fixture if explicitly enabled.
- No external GitHub issue/repository access exists in this implementation; there is no GitHub integration test.
