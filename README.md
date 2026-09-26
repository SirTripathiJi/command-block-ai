# Autonomous Multi-Agent Software Engineering Harness

This text-only Node.js harness accepts a software issue, asks a configured language model to create a bounded plan, routes plan steps to registered agents, applies workspace-limited changes, runs project tests, performs bounded recovery, and returns a structured result. A model's completion claim is not verification evidence.

## Evaluation quick start

Requires Node.js 18 or later and npm. From the repository root:

```sh
make setup
make run
make test
```

`make run` starts the CLI and prompts for one issue on standard input. The evaluator can type or pipe the issue, for example `printf '%s\n' 'Describe the issue here' | make run`. The harness reads provider settings and `AI_API_KEY` from the process environment. It includes a generic OpenAI-compatible adapter for DeepSeek and Qwen as well as support for a custom adapter module. No key is bundled.

`make test` runs the deterministic Node test suite. Tests use mock providers and temporary workspaces; they do not call a live model or network service. `make clean` removes generated dependency, coverage, and log directories.

Run `npm run test:evaluation` to copy the project to a fresh temporary directory and simulate the evaluator's `make setup`, `make test`, stdin-driven `make run`, and `make clean` sequence. The smoke test supplies a generated harmless key placeholder and confirms that an unconfigured provider produces a redacted structured `configuration_error`. It excludes local output archives, caches, dependencies, logs, temporary files, and secret `.env` files from the copy.

## Architecture and workflow

The planner sees only registered agents and available tool metadata. The plan validator rejects unknown agents or tools, missing dependencies, duplicate IDs, cycles, disallowed tool permissions, and plans over the configured step limit. The scheduler uses dependency relationships and stable plan order, with bounded concurrency. A failed or timed-out step blocks its descendants, while independent steps may finish.

Registered agents are Researcher, Investigator, API Specialist, Developer, QA, and Reviewer. API Specialist is read-only and can inspect files, Git state/diffs, and run configured tests. Developer receives completed upstream findings and has patch-safe file tools. QA relies on actual test tool output; final code verification requires a recorded file change, passing QA, a Reviewer tool artifact showing that it inspected the diff, and a fresh successful Git diff after workflow execution. Recovery is bounded by `MAX_FIX_ATTEMPTS`; agent retries are bounded by `MAX_AGENT_RETRIES`.

Tools include workspace file listing/reading/search, exact text edits, create-without-overwrite, fixed read-only Git status/diff, and bounded test execution. The source also provides a `run_command` tool factory for custom integrations; the default CLI does not register it. A custom integration that registers it must configure an exact command and argument list in `ALLOWED_COMMANDS`. The scheduler result and task result include step outcomes, changed files, tests, review results, recovery attempts, verification details, and an `outcome` of `success`, `failure`, `partial_failure`, `blocked`, `timeout`, `configuration_error`, or `in_progress`.

## Evidence-Based Task Completion

Final success is based on evidence recorded from controlled tools and repository state, not an agent's claim. A code-change task must show successful file-operation evidence, an actually executed passing test command, a Reviewer inspection of Git status and diff, a fresh final diff/status inspection, and no unexpected workspace changes or unresolved recovery failures. LLM-reported `filesChanged` values do not count as file changes. Plans without a Developer step can complete as no-code-change work and are reported as such; they do not claim that a fix was implemented.

Outcomes distinguish `success`, `failure`, `partial_failure`, `blocked`, `timeout`, `configuration_error`, `invalid_input`, `resource_limit`, and `verification_failed`. The result includes the selected plan, executed step states, actual file-change metadata, test command/exit evidence, review evidence, recovery history, and the reason for the outcome. File contents are not retained in task observability and captured test output is bounded. Deterministic local simulations do not establish live-provider evaluation results.

## Real LLM Provider Configuration

The harness core remains provider-neutral: the planner, agents, tool loop, orchestrator, QA, review, and verification use one normalized provider contract. The built-in `OpenAICompatibleProvider` translates that contract to Chat Completions requests and responses. It supports DeepSeek and Qwen without vendor SDKs. DeepSeek uses its documented `https://api.deepseek.com` base URL when `LLM_ENDPOINT` is omitted and explicitly disables thinking mode because the current tool loop does not carry thinking-state data across turns ([DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/), [thinking-mode tool-call protocol](https://api-docs.deepseek.com/guides/thinking_mode/)). Qwen endpoints depend on region and workspace, so Qwen requires an explicitly configured endpoint ([Alibaba Cloud endpoint configuration](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)). Model names are supplied through configuration rather than guessed.

Example environment configuration (use a real credential only in your shell or secret manager):

```sh
export AI_API_KEY='provided-out-of-band'
export LLM_PROVIDER=deepseek # or qwen
export LLM_MODEL='model-name-provided-for-your-account'
# Required for Qwen; optional override for DeepSeek:
export LLM_ENDPOINT='https://your-region.example/v1'
export LLM_TIMEOUT_MS=30000
export LLM_MAX_RETRIES=2
```

`LLM_ENDPOINT` accepts a base URL or a full `/chat/completions` URL. Do not put credentials in endpoint URLs. A custom CommonJS adapter remains supported with `LLM_PROVIDER_MODULE=/path/to/provider.js`; it takes precedence over the built-in provider and must export `createProvider(config)`, returning an object with `generate(request, options)`. If neither a custom module nor supported `LLM_PROVIDER` is configured, startup returns a structured configuration error. `AI_API_KEY` is never stored in task state or emitted in provider errors. Authorization headers and provider response bodies are not logged. The adapter bounds response size, uses request timeouts and abort signals, retries only bounded transient failures, and does not enable reasoning/thinking mode.

### Deterministic local tests vs opt-in live provider tests

`make test` and `npm run test:evaluation` are deterministic local checks and make no live provider calls. `RUN_LIVE_LLM_TESTS=1` enables the minimal live smoke test; `RUN_LIVE_LLM_E2E=1` separately enables the isolated end-to-end fixture test. Both require a real `AI_API_KEY`, `LLM_PROVIDER`, and applicable model/endpoint settings. The end-to-end test copies a small fixture into a temporary workspace and runs the normal planner → tool loop → Developer → QA → Reviewer → verification workflow there. Live tests are not evidence that an organizer evaluation has passed. The application does not load `.env` automatically; `.env.example` contains blank placeholders only.

## Configuration

`WORKSPACE_ROOT` selects an existing directory; the default is the current working directory. `TEST_COMMAND` may be a JSON string array, for example `["npm","test"]`. Without it, the harness detects npm, pytest, or Go test commands when their project files are present. Test processes use argument arrays with shell parsing disabled, the workspace as their working directory, timeouts, and output caps.

Bounds are validated at startup. Defaults and maximums are:

| Setting | Default | Maximum |
| --- | ---: | ---: |
| `MAX_CONCURRENCY` | 2 | 8 |
| `MAX_PLAN_STEPS` | 12 | 100 |
| `MAX_AGENT_STEPS` | 12 | 100 |
| `MAX_TOOL_CALLS` | 8 | 500 |
| `MAX_LLM_CALLS` | 100 | 1000 |
| `MAX_EXECUTION_TIME_MS` | 120000 | 3600000 |
| `STEP_TIMEOUT_MS` | 60000 | 3600000 |
| `COMMAND_TIMEOUT_MS` | 10000 | 600000 |
| `MAX_COMMAND_OUTPUT_BYTES` | 100000 | 10485760 |
| `MAX_FIX_ATTEMPTS` | 3 | 10 |
| `MAX_AGENT_RETRIES` | 1 | 10 |
| `RETRY_LIMIT` | 2 | 20 |
| `LLM_TIMEOUT_MS` | 30000 | 300000 |
| `LLM_MAX_RETRIES` | 2 | 10 |

`MODEL_TEMPERATURE` is limited to 0–2 and `MAX_TOKENS` to 1–100000. Malformed, negative, and out-of-range values fail with a configuration error. `ALLOWED_COMMANDS` is empty by default.

## Safety boundaries and limitations

Workspace paths must be relative and remain under the configured root, including after symlink resolution. File reads, listings, and searches are capped. File edits require one unique matching snippet; file creation refuses overwrite. Git tools use fixed read-only subcommands. Command execution uses `execFile` with `shell: false`, a configured working directory, exact allowlist argument matching, timeout, and output limit. Test commands are explicitly configured or safely detected; project test scripts execute with the current user's OS permissions, so the harness is not an OS-level sandbox.

Timed-out steps are marked inactive and the scheduler proceeds without waiting indefinitely. JavaScript promises and some already-started tool operations cannot be forcibly canceled safely; the harness does not claim hard cancellation. Avoid concurrent tasks that edit the same paths. `.git` metadata is not required to initialize the harness, but Git-based review and final code verification require a Git repository. No GitHub integration, commit/push automation, browser automation, or unavailable specialist implementation is included.
