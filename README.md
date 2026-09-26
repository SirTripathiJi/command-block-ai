# Autonomous Multi-Agent Software Engineering Harness

This text-only Node.js harness accepts a software issue, asks a configured language model to create a bounded plan, routes plan steps to registered agents, applies workspace-limited changes, runs project tests, performs bounded recovery, and returns a structured result. A model's completion claim is not verification evidence.

## Evaluation quick start

Requires Node.js 18 or later and npm. From the repository root:

```sh
make setup
make run
make test
```

`make run` starts the CLI and prompts for one issue on standard input. The evaluator can type or pipe the issue, for example `printf '%s\n' 'Describe the issue here' | make run`. The harness reads `AI_API_KEY` from the process environment. It also requires an organizer supplied provider adapter through `LLM_PROVIDER_MODULE`; if that adapter is missing, startup prints a structured configuration error and exits nonzero. No key or provider is bundled.

`make test` runs the deterministic Node test suite. Tests use mock providers and temporary workspaces; they do not call a live model or network service. `make clean` removes generated dependency, coverage, and log directories.

Run `npm run test:evaluation` to copy the project to a fresh temporary directory and simulate the evaluator's `make setup`, `make test`, stdin-driven `make run`, and `make clean` sequence. The smoke test supplies a generated harmless key placeholder and confirms that an unconfigured provider produces a redacted structured `configuration_error`. It excludes local output archives, caches, dependencies, logs, temporary files, and secret `.env` files from the copy.

## Architecture and workflow

The planner sees only registered agents and available tool metadata. The plan validator rejects unknown agents or tools, missing dependencies, duplicate IDs, cycles, disallowed tool permissions, and plans over the configured step limit. The scheduler uses dependency relationships and stable plan order, with bounded concurrency. A failed or timed-out step blocks its descendants, while independent steps may finish.

Registered agents are Researcher, Investigator, API Specialist, Developer, QA, and Reviewer. API Specialist is read-only and can inspect files, Git state/diffs, and run configured tests. Developer receives completed upstream findings and has patch-safe file tools. QA relies on actual test tool output; final code verification requires a recorded file change, passing QA, a Reviewer tool artifact showing that it inspected the diff, and a fresh successful Git diff after workflow execution. Recovery is bounded by `MAX_FIX_ATTEMPTS`; agent retries are bounded by `MAX_AGENT_RETRIES`.

Tools include workspace file listing/reading/search, exact text edits, create-without-overwrite, fixed read-only Git status/diff, and bounded test execution. The source also provides a `run_command` tool factory for custom integrations; the default CLI does not register it. A custom integration that registers it must configure an exact command and argument list in `ALLOWED_COMMANDS`. The scheduler result and task result include step outcomes, changed files, tests, review results, recovery attempts, verification details, and an `outcome` of `success`, `failure`, `partial_failure`, `blocked`, `timeout`, `configuration_error`, or `in_progress`.

## Evidence-Based Task Completion

Final success is based on evidence recorded from controlled tools and repository state, not an agent's claim. A code-change task must show successful file-operation evidence, an actually executed passing test command, a Reviewer inspection of Git status and diff, a fresh final diff/status inspection, and no unexpected workspace changes or unresolved recovery failures. LLM-reported `filesChanged` values do not count as file changes. Plans without a Developer step can complete as no-code-change work and are reported as such; they do not claim that a fix was implemented.

Outcomes distinguish `success`, `failure`, `partial_failure`, `blocked`, `timeout`, `configuration_error`, `invalid_input`, `resource_limit`, and `verification_failed`. The result includes the selected plan, executed step states, actual file-change metadata, test command/exit evidence, review evidence, recovery history, and the reason for the outcome. File contents are not retained in task observability and captured test output is bounded. Deterministic local simulations do not establish live-provider evaluation results.

## Provider configuration

Provider details and the evaluation model have not been supplied here. The harness therefore does not select a vendor, endpoint, SDK, or model. An organizer-provided CommonJS module must export `createProvider(config)` and return a provider with `generate(request, options)`. The adapter receives the validated request and options `apiKey`, `model`, `endpoint` (when configured), `temperature`, `maxTokens`, `timeoutMs`, and an `AbortSignal`. It must return `{type:"final",content:string}` (also accepts normalized `{type:"message",content:string}`) or `{type:"tool_call",tool:string,arguments:object}`. Vendor-specific formats stay behind the adapter. The core bounds request sizes, response shapes, call time, and retries; it retries explicit transient failures, network errors, HTTP 429, and HTTP 5xx only. `MockProvider` is used for deterministic local simulations and never makes network requests.

Set these values in the evaluation process environment:

```sh
export LLM_PROVIDER_MODULE=/path/to/organizer-provider-adapter.js
```

Set `LLM_MODEL`, `LLM_ENDPOINT`, `LLM_TIMEOUT_MS` (1–300000, default 30000), and `LLM_MAX_RETRIES` (0–10, default 2) only when the organizer supplies their values. Provider loading, initialization, interface, request, response, authentication, timeout, and exhausted-retry errors have distinct safe codes. Task results expose aggregate LLM activity and safe error codes; prompts, responses, credentials, and configured endpoints are not logged.

The evaluator injects `AI_API_KEY`; it must not be written to source, README, test fixtures, or `.env`. `.env.example` contains only blank configuration values. The application does not load `.env` automatically.

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
# command-block-ai
