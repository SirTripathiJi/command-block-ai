# Senior Developer Audit — AI Harness `11`

Audit date: 2026-09-27 (Asia/Kolkata)  
Audited folder: `~/Desktop/11`

## Executive summary

This is a materially newer version than `AI-Harness-Phase-10-Stable`. It has added a real OpenAI-compatible HTTP adapter with DeepSeek and Qwen selection, configurable model/endpoint values, timeout/retry handling, response-size limits, safe error categories, and opt-in live tests. It is no longer true that there is no built-in network adapter.

However, **the live AI workflow is still unverified and the app does not complete a real task from this folder as currently configured**. The official instructions supplied for this audit say the evaluation uses DeepSeek and Qwen model families. The exact model IDs and whether the evaluator sets `LLM_PROVIDER`, `LLM_MODEL`, and `LLM_ENDPOINT` are still unclear. The documented standard command sequence only tells participants to export `AI_API_KEY`; an actual run with only that variable and a valid issue exits with `provider_not_configured`. No real key was supplied or used.

The deterministic tests passed after a focused test-only expansion: **104 total, 102 passed, 0 failed, 2 live tests skipped**. The skipped tests are not evidence of a live pass. The clean-copy smoke simulation passed, but it deliberately tests the missing-provider error. This folder also has no `.git` metadata, which prevents inspection of user changes and prevents a live Git diff-review demonstration from this copy.

One security issue needs a decision before real use: `src/llm/openaiCompatibleProvider.js` accepts an `http://` endpoint and sends the API key in a Bearer Authorization header. An HTTP endpoint can expose the credential to network observers. Prefer HTTPS-only unless the organizer explicitly requires a trusted local HTTP endpoint and the team knowingly accepts that risk.

No verified P0 application-code defect was found that could be fixed without the organizer's model instructions. I added 21 useful provider boundary tests and corrected one mistaken assertion in that new test set; I did not alter application code or select a model. Reports were newly created under `reports/`.

## Repository inventory and technology

- `Makefile`: setup, run, test, clean targets.
- `package.json` / `package-lock.json`: Node.js CommonJS project, Node >=18, built-in `node:test`; no external npm packages declared.
- `README.md`: quick start, supported provider configuration, architecture, safety limits, and live-test instructions.
- `.env.example` / `.gitignore`: blank environment placeholders; `.env` excluded.
- `src/index.js`, `src/config/index.js`: line-oriented stdin CLI and centralized environment/config parsing.
- `src/llm/provider.js`, `openaiCompatibleProvider.js`, `client.js`, `mockProvider.js`: built-in provider selection, HTTP translation, normalized client contract, and test mock.
- `src/core/`: planning, schema validation, tool loop, agent registry, state, execution scheduling, context assembly, orchestration, evidence/recovery.
- `src/agents/`: LLM-backed agents and API specialist; `skeletons.js` remains a not-implemented alternative/legacy agent factory.
- `src/tools/`: workspace-scoped listing/read/search/edit/create, fixed read-only Git status/diff, test runner, optional command tool.
- `tests/core/`, `tests/integration/`, `tests/tools/`, `tests/fixtures/`: deterministic unit/integration/security fixtures plus opt-in live tests.
- `scripts/evaluator-smoke.js`: clean temporary copy of setup/test/missing-provider/redaction/cleanup sequence.
- `reports/`: created in this audit with the audit and test evidence.

No `.git` folder exists in the audited copy. `git status --short --branch` returned `fatal: not a git repository`. Existing Git changes/history therefore cannot be inspected; do not infer a clean working tree.

## Actual execution flow

1. `src/index.js` asks for one software issue through stdin. Blank input and inputs over 10,000 UTF-8 bytes are rejected.
2. `loadConfig` reads `AI_API_KEY`, `LLM_PROVIDER`, `LLM_MODEL`/`MODEL_NAME`, `LLM_ENDPOINT`, and execution limits. It validates provider names and config bounds.
3. `loadProvider` uses a custom `LLM_PROVIDER_MODULE` if configured; otherwise it selects the built-in adapter for `LLM_PROVIDER=deepseek` or `qwen`.
4. The planner sends text messages and tool metadata through `LLMClient`. `OpenAICompatibleProvider` formats a Chat Completions POST, sends the key in `Authorization: Bearer ...`, then converts final text/tool calls back to the core contract.
5. The planner's JSON is parsed and validated for registered agents/tools, permission grants, task bounds, dependencies, cycles, and QA/review order.
6. Agents inspect relevant files; Developer can use exact unique-snippet edits or create a new file without overwriting. Tool access is restricted by each agent's registered tool set.
7. QA runs the configured or safely detected test command. Bounded recovery may ask Developer to fix test failures. Reviewer inspects Git status/diff. The orchestrator requires real change, test, reviewer, and final diff evidence before claiming a verified code change.
8. The CLI prints structured JSON; startup/configuration errors are redacted and structured. The app does not create commits, push branches, open PRs, or fetch GitHub issues.

The adapter is real code, but only mock-backed tests were run here. A code path that exists is not proof that the organizer's model/endpoint supports every required tool-call behavior.

## Hackathon requirement checklist

| Requirement | Status | Evidence and caveat |
| --- | --- | --- |
| Root Makefile exists | PASS | Inspected `Makefile`; contains setup/run/test/clean. |
| `make setup` installs dependencies | PASS | Ran; exit 0, npm reported up to date. The project declares no npm runtime dependencies. |
| `make test` runs actual tests | PASS | Final run: 104 cases, 102 pass, 0 fail, 2 intentionally skipped live tests. |
| `make run` launches actual harness | PARTIAL | CLI launched, read issue, then stopped with `provider_not_configured`. Live workflow not verified. |
| Works without undocumented manual setup | FAIL for the published key-only workflow | Supplied standard workflow only exports `AI_API_KEY`. With only that variable set, `make run` prompts, accepts the issue, then exits with `provider_not_configured`; it also needs provider/model settings (and a Qwen endpoint). |
| API key comes from `AI_API_KEY` | PASS (implementation/tests) | Config and provider read it; unit test checks absent-key error; key was not supplied. |
| No secrets or real API keys committed | NOT VERIFIED | `.env.example` blank and `.env` ignored; no Git metadata, so tracked history cannot be inspected. |
| Configured model clearly identified | PARTIAL | Organizer instructions now identify DeepSeek and Qwen families, and code supports both, but the project has no default model ID; `LLM_MODEL` is required. Exact IDs and endpoint provisioning are unresolved. |
| Text-only model input | PASS (implementation) | Adapter maps string chat messages and tool schemas; no image input path. No live request performed. |
| Prescribed model configurable without source edits | PARTIAL | `LLM_MODEL` and `LLM_ENDPOINT` are environment-configurable, and custom adapters are supported. Exact prescribed model/endpoint compatibility remains unverified. |
| Clean environment with required commands | PARTIAL | `npm run test:evaluation` passes in a clean copy; its run check expects missing-provider failure, not successful AI task completion. |
| README run/test instructions | PASS | Commands, provider env variables, live-test opt-ins, and limitations are described. |

**Unresolved external dependency:** exact DeepSeek/Qwen model IDs and whether evaluation injects provider/model/endpoint variables beyond `AI_API_KEY`. Do not guess a model ID or endpoint. The family restriction is known from the supplied organizer instructions.

## Command execution evidence

Full result counts and test scope are in [TEST_RESULTS.md](TEST_RESULTS.md).

- `make setup`: PASS, exit 0 (`up to date in 202ms`).
- `make test`: final result PASS, exit 0: 104 total / 102 passed / 0 failed / 2 skipped.
- `make run` with input `Explain a bug in a disposable project`, and only `AI_API_KEY` set to a harmless audit placeholder: nonzero exit 2 from Make. CLI returned structured `configuration_error`, code `provider_not_configured`, instructing the user to set `LLM_PROVIDER` or a custom module. No live request occurred. Two harmless macOS `make` warnings reported fallback to `/tmp` because the sanitized environment omitted the user's temp-directory variable.
- `npm run test:evaluation`: PASS, exit 0, isolated temporary copy completed setup/tests/missing-provider redaction/cleanup.
- Live smoke and live E2E tests: skipped; no real key/model supplied.

## Security findings

### P1 — API key can be sent over plain HTTP

- **Where:** `src/llm/openaiCompatibleProvider.js`, constructor permits both `https:` and `http:`; `generate` sends `Authorization: Bearer ${apiKey}`.
- **Trigger:** configure `LLM_ENDPOINT=http://...` for a remote endpoint, intentionally or by mistake.
- **Impact:** anyone able to observe that network traffic may capture and reuse the API key and spend quota/access the account.
- **Fix:** reject `http:` by default. If the organizer mandates local HTTP, require a separate explicit opt-in limited to loopback addresses and document the risk. Never allow embedded URL credentials (already rejected).
- **Verification:** add tests that public HTTP URLs fail, HTTPS succeeds, and any permitted loopback exception cannot target a remote host.

### Other reviewed boundaries

- API key is not interpolated into error messages and tests check redaction. The adapter does not log request headers/body/provider error bodies. The CLI strips the key from thrown startup errors.
- Fetch uses `redirect: 'error'`, which avoids forwarding the Authorization header through redirects.
- Tool and path permissions are validated; file tools check resolved workspace containment and edit/create semantics. Git operations are fixed read-only `status`/`diff` calls.
- Shell syntax is disabled for subprocesses, and optional custom commands require an exact allowlist. Test commands still run with the user's OS permissions and are not a system sandbox.
- **Prompt injection risk:** issue text and repository source/README content can contain malicious instructions. System prompts and allowed tools reduce impact but do not prove a model will ignore hostile text. Keep changes in a disposable branch, inspect diff, and consider explicit untrusted-content framing and approval before writes.
- **No per-edit confirmation or transaction rollback:** model edits can remain after failed QA. Use a clean branch/worktree and inspect `git diff`; implement a rollback/approval mechanism if the intended product requires safer interactive behavior.
- **Filesystem race:** path containment check and later read/write are separate calls; a hostile concurrent process could race symlink replacement. OS isolation is stronger for hostile repositories.
- No dangerous command was run against the project. `make clean` is only run inside the disposable evaluator simulation.

## Implemented, partial, mock, and missing features

- **Implemented in source:** stdin issue entry, config validation, OpenAI-compatible adapter, custom-provider contract, model text/tool-call normalization, bounded retries/timeouts/response sizes, agent planning, tools, file patching, test execution, recovery, Git review evidence.
- **Verified locally with mocks:** provider formatting/error cases, planning/scheduling, tool permissions, patch handling, QA/recovery, review evidence, path checks, and credential redaction. 102 cases passed.
- **Not verified live:** authentication against the organizer provider, prescribed model compatibility, real tool calls, real model-driven patch, real live-agent recovery, real completion/reviewer quality.
- **Unavailable:** exact official model IDs, confirmation of how the evaluator sets provider/endpoint configuration, and live credentials; Git metadata in this copy.
- **Not implemented:** GitHub issue retrieval, remote clone selection, commit/push/PR automation, web app/server. These are optional unless the rules require them; do not build speculatively.
- **Not implemented agent options:** `src/agents/skeletons.js` returns `not_implemented`; the runtime uses LLM agents from `llmAgents.js`. Keep this distinction clear in demos.

## Architecture and code quality

The module boundaries are reasonable for a hackathon prototype: provider/client, orchestration, tools, agents, and tests are separated. Centralized bounds and deterministic integration tests are strengths. The new adapter is a meaningful step beyond the previous copy.

Maintenance concerns: several central modules are compressed into long one-line functions, increasing review difficulty; `skeletons.js` can mislead developers because it duplicates agent factory naming while returning not-implemented agents; the adapter assumes a Chat Completions-compatible API and tool-call protocol, which must be checked against organizer specs. Simplify only after a live end-to-end run. Do not rewrite the architecture or add GitHub/web features before the official provider path is demonstrated.

## Reality check — direct answers

1. **Does it perform its advertised task?** It has code for the workflow and a mock-driven test proves much of the control flow. A real model-generated fix was not verified.
2. **Can evaluator clone and run it?** Setup and tests work. With valid official environment settings, it may run; absent those settings it exits clearly with `provider_not_configured`. There is no proof here of a successful evaluator-configured run.
3. **Does AI integration really work?** A real HTTP adapter now exists. Only fake-fetch/unit tests ran. Live connection/auth/model response is unverified; test mocks are not live evidence.
4. **Invalid issue/broken repo?** Empty/oversized issues are structured input failures. Missing provider yields configuration failure. Broken repo/tool/test errors should be represented by harness failures, but real-provider behavior on a broken repository was not exercised. Git review requires Git metadata.
5. **API failure/timeout/malformed output?** Safe categories, timeout/retry logic, and malformed-response behavior have mock tests. Real vendor-specific edge cases and actual credentials are unverified.
6. **Single biggest technical risk?** The published evaluator steps provide only `AI_API_KEY`, but the current app also requires provider/model configuration before it can make a request. With the supplied key-only sequence, a real issue cannot be handled.
7. **Three biggest blockers:** (a) align app startup with the official key-only run instructions or get confirmation that evaluator supplies provider/model/endpoint variables; (b) obtain exact DeepSeek/Qwen model IDs and run the live smoke and E2E tests; (c) perform Git status/diff review from the actual Git clone. Also fix/decide the HTTP endpoint key-exposure issue.
8. **What might be mistaken as complete?** The presence of `openaiCompatibleProvider.js` and skipped live-test names may look like a verified integration. They are not proof of a real successful call. The README's manual `LLM_PROVIDER`/`LLM_MODEL` setup also conflicts with the supplied evaluator quick path unless evaluators inject those values.
9. **Demo risk:** using only the documented `AI_API_KEY` export, app accepts an issue then stops at provider configuration; even when configured, an endpoint/model mismatch or quota issue can stop the demo.
10. **What to fix/stop building:** complete one authorized live task and address HTTP transport policy. Stop adding optional agents, GitHub features, and UI polish until that flow is proven.

## Prioritized plan

| Priority | File/component | Problem | Recommended fix | Complexity | Verification |
| --- | --- | --- | --- | --- | --- |
| P0 | `src/config/index.js`, `src/llm/provider.js`, `README.md`, evaluator setup | Official run instructions say to provide `AI_API_KEY`, but app currently also requires `LLM_PROVIDER` and `LLM_MODEL` (and Qwen endpoint). A run using only the published setup reaches a configuration error. | Either have organizers confirm these extra variables are injected, or configure approved DeepSeek/Qwen model IDs as permitted defaults without asking evaluators to edit source. Do not invent IDs. | Medium | In a clean clone, use exactly the official exports plus issue input; app must reach a real model request with the prescribed model. |
| P0 | `tests/integration/liveProvider.test.js` | Both live tests skipped, so the real provider and true end-to-end path remain unknown. | Run `RUN_LIVE_LLM_TESTS=1` and `RUN_LIVE_LLM_E2E=1` separately on a permitted model/key; inspect temporary fixture result. | Easy once access exists | Both tests pass without key appearing in logs; end-to-end fixture changed and tests pass. |
| P0 | Actual Git clone | Desktop `11` has no `.git`; no status/history or real diff inspection here. | Use the actual clone/clean branch for final audit/demo. | Easy | `git status --short --branch`, `git diff --check`, and harness Git tools work. |
| P1 | `src/llm/openaiCompatibleProvider.js` | Plain HTTP is allowed while transmitting bearer key. | Require HTTPS except explicitly approved loopback-only use; add boundary tests. | Easy | HTTP remote rejected; HTTPS works; any exception constrained to localhost. |
| P1 | Agent prompts and file tools | Untrusted issue/repository text can try prompt injection; edits happen without user approval. | Label repository/task content untrusted, keep tool allowlists authoritative, inspect every diff; consider explicit approval before writes. | Medium | Malicious fixture cannot call unregistered tool or write outside workspace; human-reviewed change. |
| P1 | Test runner/runtime environment | Project tests run with host OS permissions, despite credential stripping. | Use disposable container/worktree for untrusted repos; make limits clear in demo. | Medium/Hard | Fixture cannot reach host paths/secrets inside chosen isolation. |
| P2 | `src/agents/skeletons.js` | Dead/not-implemented agent factory can confuse future developers. | Remove or rename/document if evaluator does not import it. | Easy | Search import graph and rerun full suite. |
| P2 | `src/core/*`, `src/tools/*` | Dense formatting makes review/maintenance harder. | Format incrementally after the live path is stable. | Medium | No behavior change; full suite remains green. |

### Integration checklist

| Integration | Status | Need / next action | Verification |
| --- | --- | --- | --- |
| Official text-only LLM | Provider families known (DeepSeek and Qwen); exact model IDs and eval env behavior unresolved | Confirm IDs and whether provider/model/endpoint are injected. Current README's manual environment steps go beyond the published standard workflow. | Run live smoke, then live isolated E2E using the official workflow. |
| `AI_API_KEY` | Implemented; no key available | Inject from shell/secret system only; no source/report/env commit. | Missing-key and redaction tests, then live test. |
| GitHub issue/repository | Absent | Not needed for current local stdin/local workspace design unless rules explicitly require it. | If required, add an approved integration and isolated fixture tests. |
| Safe local repo selection | Workspace root exists; actual user selection is environment/current directory | Demo only against a clean Git branch/worktree. | Verify workspace root and diff in clone. |
| Source analysis/context | Implemented with bounded file/search tools | Live quality not verified. | Live task with known fixture and inspect cited evidence. |
| AI patch handling | Implemented as exact text edit/create without overwrite | No confirmation/rollback; review diff. | Live fixture and ensure only expected file changes. |
| Test execution/reporting | Implemented; command arrays, no shell, bounded output/time | Tests aren't OS-isolated. | Existing subprocess tests plus disposable live fixture. |
| Terminal interaction | Minimal one-line CLI, not rich TUI | Adequate unless rules request richer TUI; issue input cannot be multiline in one prompt. | Manual run and EOF/invalid-input tests. |
| Logging/recovery | Structured safe logs and bounded recovery | Provider-specific live behavior not tested. | Live failure/timeout test if allowed, with secret redaction. |

## Changes made and remaining blockers

- Added 21 focused, meaningful tests to `tests/core/openaiCompatibleProvider.test.js`; final expanded suite passes. No application source, model selection, or credential configuration was changed.
- Created `reports/SENIOR_DEVELOPER_AUDIT.md` and `reports/TEST_RESULTS.md`.
- The folder has no `.git` metadata. `git status` failed because this is not a Git repository, so I could not establish whether files were pre-existing user changes or inspect a diff. The test file and reports are the files this audit wrote.
- Remaining blockers: organizer-approved model/endpoint/credential instructions; live smoke + live end-to-end result; real Git clone review; HTTP endpoint security policy.

## Exact pre-submission commands

Use the actual clone, clean working tree/branch, and organizer-approved values:

```sh
make setup
make test
export LLM_PROVIDER='<organizer-approved-provider>'
export LLM_MODEL='<exact-organizer-model-name>'
export AI_API_KEY='<inject securely; never commit or print>'
# Set LLM_ENDPOINT only as required by the organizer/provider.
RUN_LIVE_LLM_TESTS=1 node --test tests/integration/liveProvider.test.js
RUN_LIVE_LLM_E2E=1 node --test tests/integration/liveProvider.test.js
make run
git status --short --branch
git diff --check
```

The supplied instructions identify DeepSeek and Qwen as evaluation families. Obtain exact IDs and confirm whether the evaluator supplies provider/model/endpoint settings. Do not guess those values or put a real key in command history. Run the demo against a disposable branch and inspect the final diff yourself.
