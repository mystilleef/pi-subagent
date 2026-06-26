# ORIENT

## Scope

- Project: Pi extension for delegated child agents in Structured Prompt
  Agent Ecosystem (SPAE)-style workflows.
- Sources: README, DESIGN, SPAE specs, source tree.
- `ADRs`: none found during scan.
- Claims: source/docs inference only; revisit after major lifecycle or
  UI changes.

## Architecture

- Shape: plugin shell + process-supervised actor + `renderer`
  projections.
- `index` layer: Pi extension adapter; registers interactive adapters,
  delegation tool, and custom message `renderers`; delegates work to
  orchestration.
- `orchestration` layer: lifecycle coordinator; discovery, confirmation,
  job registry, progress kickoff, child runner, result/failure routing,
  notification trigger.
- `agent` layer: agent definition discovery; user/project scope merge;
  scoped cache; `frontmatter` parsing; sampling/model/tool/skill
  metadata validation.
- `child` layer: process runner; prompt materialization; child process
  `args`; JSON event parsing; runtime result assembly; abort/termination
  cleanup.
- `progress` layer: mutable in-memory projection keyed by request id;
  running activity extraction; terminal summary derivation.
- `output` layer: pure text/terminal rendering and parent-facing result
  formatting.
- `notification` layer: request construction separated from
  platform-specific detached delivery.

## Primary flow

- Launch request enters `startSubagentJob`.
- Agent discovery reads user/project definitions through cached
  snapshots; project-local selection prompts trust confirmation;
  project/user name collision emits a progress notice.
- Prepared job creates:
  - `RunJob` cancellation entry
  - `SubagentProgressState`
  - request id + instance name
  - sanitized details builder
- Root-level interactive launch schedules lifecycle asynchronously and
  returns a started result; nested/tool launch awaits lifecycle inline.
- Lifecycle loop:
  - timer invalidates progress renderer
  - update callback patches progress and throttles host updates via
    payload fingerprint
  - child runner resolves agent settings, skills, sampling, prompt
    contract, temp prompt, and child invocation
- Child runner streams known JSON events:
  - message/tool-result events update `RuntimeResult`
  - tool-execution events update nested `ToolActivity`
  - agent-end events rebuild messages, emit progress, then request
    graceful termination after grace window
- Finalization:
  - complete-tool arguments yield `outcome`
  - semantic success stores `outcome`
  - abort returns tagged `aborted` result and clears `stderr`
  - unresolved tool errors mark failure
- Orchestrator terminal routing:
  - success sends raw final output to parent/result card and stores
    canonical progress summary
  - failure prefixes parent content with explicit failure marker and
    optional partial output
  - cancellation sends canonical cancellation content, updates cancelled
    progress, suppresses duplicate nested behavior
- Completion cleanup removes job, clears render timer, finalizes
  notification/beep path.

## Core abstractions

**`AgentConfig`** (agent + child): parsed prompt/frontmatter plus launch
metadata—source scope and file origin.

**`AgentDiscoveryCacheEntry`** (agent cache): `TTL` snapshot with
directory listing trust + file hashes-enables safe derivation of scoped
caches from combined scope.

**`RunJob`** (run registry + orchestrator): cancellable background job
record bridging interactive cancellation and lifecycle signal.

**`SingleResult`** (child + progress + output): cross-boundary result
envelope carrying output, usage, messages, progress, termination,
outcome.

**`SubagentDetails`** (orchestrator + progress details): sanitized
result container passed to UI/tool callbacks.

**`RuntimeResult`** (child result builder): mutable child-side
`SingleResult` with message accumulation invariant.

**`StreamingProgress` / `ToolActivity`** (child events + progress):
tree-shaped live tool activity for nested subagent visibility.

**`RunSingleAgentResult`** (child process + orchestrator): tagged
completion/abort union—expected cancellation never travels as exception.

## Invariants

- `SingleResult.finalOutput` tracks last assistant text during message
  append/rebuild; completed result cards read this field directly. A
  missing `finalOutput` means no text output—render `"(no output)"`;
  never `rescan` messages to recover it.
- `content[0].text` carries parent/custom-message payload only; never
  treat it as final-output fallback after completion.
- `getFeedbackSummaryText` feeds the progress store only; it must never
  read `content[0].text`, which carries streaming activity text—stale at
  finalization.
- `outcome` summarizes progress only; parent-facing success content
  retains raw final output plus thinking warning.
- Failure parent content format:
  `"(failed) <errorMessage>\n\n<finalOutput>"` when partial output
  exists; just `"<errorMessage>"` with no partial output.
- Complete-tool outcome extraction reads assistant tool-call arguments,
  not tool-result payload.
- `hasSubagentFailed` honors valid outcome as success override;
  otherwise exit code, stop reason, error message, and post-output tool
  errors drive failure.
- Expected cancellation flows through `RunSingleAgentResult.kind`; only
  unexpected errors enter orchestrator catch.
- Non-debug details strip messages, termination internals, and `stderr`;
  display debug path redacts sensitive fields recursively.
- Progress store strips transient tool activity after terminal states.
- Root-level child jobs run outside the tool call stack; nested subagent
  jobs run inline to return payload to parent agent.
- Project-local agents require explicit UI trust confirmation before
  execution.
- Sleep inhibition and process-tree termination live with child runner,
  not orchestration.

## Boundaries for changes

- Add or change launch policy in orchestrator; keep `index` as
  registration adapter.
- Keep agent markdown parsing in discovery; keep cache validity in cache
  module.
- Keep child process concerns—argument construction, event parsing, temp
  prompt lifecycle, termination, result construction—inside child
  modules.
- Keep UI/result content split:
  - parent/result body: output summary + output UI
  - progress summary: progress details + progress state
- Add new child event types through parser → process handler → progress
  projection chain.
- Extend details only through sanitizer; preserve debug authorization
  and redaction.
- Extend notifications through request model first; platform delivery
  second.
- Preserve TypeBox schema reuse between complete tool registration and
  outcome validation.
- Avoid restoring message scans in result UI; repair result construction
  instead.
- Avoid exceptions for expected abort and cancellation flow.

## Architectural traps

- Running text and final result use different channels; merging them
  reintroduces stale-result bugs.
- Result card duplication prevented through `renderedByMessage`;
  removing it duplicates custom message output.
- Scoped agent cache derivation only safe after snapshot/listing
  validation; direct reuse risks stale project/user splits.
- Tool activity can nest through subagents; flattening drops child-agent
  visibility.
- Success/failure classification depends on both process status and
  message semantics; exit code alone `misclassifies` complete-tool
  success after handled tool errors.
- Parent debug flag only exposes messages when host authorization flag
  permits; never rely on request flag alone.
- Agent-end event doesn't mean process exit; grace termination handles
  lingering child process.
- Output truncation and `stderr` capture limits protect parent context;
  bypassing them leaks large child output.

## Evidence

- README: external behavior and progress/result card split.
- SPAE specs: current design pressures around result contract, failure
  formatting, tagged abort, outcome parsing.
- Source scan: layer boundaries and invariants above.
