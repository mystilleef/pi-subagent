# ORIENT

## Scope

- Project: Pi extension for delegated child agents in `SPAE`-style
  workflows.
- Purpose: isolate child context, prompts, tools, skills, extensions,
  sampling, and model thinking from parent session while streaming
  progress back.
- Sources: README, `SPAE` specs/plans, source tree, tests.
- ADRs/design docs: none found; `SPAE` specs document recent
  thinking-resolution decisions.
- Claims: source/docs inference; revisit after lifecycle, result
  contract, or Pi extension API changes.

## Architecture

- Shape: Pi extension adapter + cached agent/resource discovery +
  process-supervised child actor + live progress/result render
  projections.
- Registration adapter:
  - tracks active workspace for completions
  - registers user launch/cancel/job adapters, subagent tool,
    progress/result renderers
  - delegates all execution policy to orchestration
- Orchestration:
  - combines discovery, trust confirmation, job registry, progress seed,
    lifecycle scheduling, cancellation, result routing, notifications
  - root launches detach lifecycle and returns started handle;
    nested/tool launches await lifecycle for parent payload
- Discovery:
  - parses agent markdown/frontmatter into `AgentConfig`
  - merges user/project scopes with project overriding user on name
    collision
  - validates model/sampling/prompt replacement metadata before spawn
  - derives scoped cache entries from trusted snapshots only
- Resource resolution:
  - converts agent skill/extension names into concrete child resource
    inputs/paths through Pi resource loader caches
  - keeps skill and extension resolution independent; unknown names
    `fail` before spawn with available-name diagnostics
- Child runner:
  - materializes prompt, resolves model/thinking display, resolves
    resources, builds child invocation, streams JSON events, accumulates
    result, manages abort/termination cleanup
- Progress/UI:
  - stores mutable in-memory progress keyed by request id
  - projects child messages and nested tool activity into cards, status
    lines, job board, and parent/tool updates
- Output:
  - separates parent text, result-card body, progress summary, and
    diagnostic details
  - preserves raw final assistant output for success payloads
- Notification:
  - builds request from terminal progress state before platform
    delivery; delivery failures never change lifecycle result

## Primary flow

- Launch enters `startSubagentJob` through command or tool adapter.
- Cached discovery selects scope; project agent prompts trust
  confirmation when UI context exists; name collision emits progress
  notice.
- Preparation creates request id, instance name, cancellable `RunJob`,
  progress state, sanitized details builder, merged abort signal, parent
  model/thinking snapshot.
- Root-level launch schedules lifecycle asynchronously and immediately
  returns started handle; nested launch awaits `runSubagentLifecycle`.
- Lifecycle loop:
  - timer invalidates progress renderer
  - update callback patches progress and throttles parent updates by
    payload fingerprint
  - runner resolves skills/extensions/prompt/model/sampling before spawn
- Child event stream:
  - message/tool-result events append messages, usage, final output, and
    error hints
  - tool-execution events merge nested `ToolActivity`
  - agent-end events rebuild full message state, emit progress, then
    request graceful termination after grace window
- Finalization:
  - latest valid `complete` tool-call arguments yield `outcome`
  - semantic success stores `outcome`
  - abort returns tagged `aborted` result and clears captured
    diagnostics
  - unresolved post-output tool errors mark failure
- Terminal routing:
  - success sends raw final output to parent/result card and concise
    outcome-derived progress summary
  - failure prefixes parent content with explicit failure marker plus
    partial output when present
  - cancellation updates progress and suppresses duplicate nested
    behavior
- Cleanup removes registry entry, clears timer, releases child
  resources, triggers completion alert path.

## Core abstractions

- `AgentConfig`: parsed agent prompt/frontmatter plus source/file
  metadata; drives prompt, tools, skills, extensions, model, sampling,
  context behavior.
- `AgentDiscoveryCacheEntry`: `TTL` snapshot with markdown listing
  trust + file hashes; enables safe `both` → scoped cache derivation.
- `RunJob`: cancellable registry record connecting jobs board,
  cancellation, lifecycle signal, and root background launch.
- `SingleResult`: cross-boundary result envelope for output, usage,
  model/thinking, progress, messages, termination, outcome.
- `RuntimeResult`: child-side mutable `SingleResult`; message
  append/rebuild updates usage and `finalOutput`.
- `SubagentDetails`: sanitized UI/tool detail payload; debug surfaces
  require host authorization and redaction.
- `StreamingProgress` / `ToolActivity`: tree-shaped activity model for
  nested tool/subagent visibility.
- `RunSingleAgentResult`: tagged completion/abort union; expected
  cancellation travels outside exception path.
- `ResolvedThinkingLevel`: display/warning/diagnostic tuple; child input
  keeps requested level separately.
- Resource caches: skill input and extension path maps keyed by
  canonical workspace, agent directory, and requested names.

## Invariants

- `SingleResult.finalOutput` tracks last assistant text during
  append/rebuild; completed cards read it directly. Empty value means no
  text output; render `"(no output)"`; never `rescan` parent content.
- `content[0].text` carries parent/custom-message payload only; never
  use it as completion fallback.
- `getFeedbackSummaryText` feeds progress store only; it must not read
  streaming parent content.
- `outcome` summarizes progress; parent-facing success content retains
  raw final output plus thinking warning.
- Complete outcome extraction reads assistant tool-call arguments, not
  tool-result payload.
- `hasSubagentFailed` treats valid `outcome` as success override;
  otherwise exit code, stop reason, error message, and post-output tool
  errors drive classification.
- Agent/provider/model precedence: agent settings override parent; agent
  provider without model invalidates discovery; agent model without
  provider inherits parent provider.
- Thinking resolution: confirmed live/static model data clamps
  display/warning; unconfirmed non-`off` requests preserve requested
  display with uncertainty warning; child input always receives raw
  requested level.
- `replacePrompt` switches only agent-body delivery; result contract
  prompt injection stays last among prompt-delivery entries.
- Agent `extensions` `frontmatter` controls extension inheritance:
  defined value disables inherited extensions, then re-adds this package
  plus resolved requested extensions and core child helpers.
- Agent `skills` `frontmatter` controls skills inheritance: defined
  value disables inherited skills, then adds resolved requested skills;
  `false` yields no requested skill entries.
- Sampling `frontmatter` travels through a child-only patch extension;
  parent process sampling payload never leaks into child unexamined.
- Project-local agents require UI trust confirmation before spawn.
- Expected cancellation returns tagged abort; unexpected errors enter
  orchestration catch.
- Non-debug details strip messages, termination internals, and captured
  `stderr`; display debug path redacts sensitive fields recursively.
- Progress store strips transient activity after terminal states.
- Output truncation and diagnostic capture limits protect parent
  context.
- Sleep inhibition and process-tree termination stay inside child
  runner.
- `agent_end` event triggers graceful shutdown, not instant
  process-success assumption; grace timeout only succeeds when child
  produced completed output/outcome.

## Boundaries for changes

- Add launch policy in orchestrator; keep `index` registration-only.
- Keep markdown/frontmatter parsing in discovery; keep snapshot/hash
  validity in cache.
- Keep Pi resource lookup inside resource-resolution; child runner
  consumes resolved resource inputs/paths only.
- Keep child process concerns—argument assembly, prompt temp files, JSON
  event parsing, event diagnostics, termination, result
  construction—inside child modules.
- Add child event types through parser → process handler → progress
  projection chain.
- Extend result/details shape through sanitizer first; preserve debug
  authorization and redaction.
- Extend UI by consuming `SubagentProgressState`/`SubagentDetails`, not
  child messages directly.
- Extend notifications through request model first; platform adapters
  second.
- Preserve TypeBox schema reuse between complete tool registration and
  outcome validation.
- Preserve model/thinking split: display resolution may warn or clamp;
  child request remains raw.
- Preserve tool activity tree; flatten only in render formatting.

## Architectural traps

- Running text and final result travel on different channels; merging
  them reintroduces stale-result bugs.
- Result-card duplication prevention hinges on `renderedByMessage`;
  removing it duplicates custom message output.
- Scoped cache derivation needs trusted snapshot/listing validation;
  direct reuse risks stale user/project splits.
- Resource caches key on canonical workspace and agent directory;
  name-only caching can cross-contaminate projects.
- Tool activity can nest through subagents; flattening drops child-agent
  visibility.
- Exit code alone `misclassifies` handled tool errors and complete-tool
  success.
- Parent debug request alone never exposes transcripts; host
  authorization and sanitizer gate detail expansion.
- Agent-end event can precede process exit; grace termination handles
  lingering child process.
- Result contract delivery through final prompt injection protects
  against lost-in-the-middle omissions; moving contract into task text
  risks missing final output.
- Agent extension inheritance differs from skill inheritance; false
  extensions still loads core child helpers after disabling host
  extensions, while false skills adds no requested skill `args`.

## Evidence

- README: extension purpose, agent/frontmatter semantics, security
  model, user-facing progress/result split.
- `SPAE` specs/plans: thinking-resolution display contract and raw child
  thinking request decision.
- Source scan: extension registration, orchestration lifecycle,
  discovery/cache, resource resolution, child runner, progress/output,
  notification boundaries.
- Tests: behavior seams for thinking propagation, child invocation,
  progress/UI/summary, caching, termination, result contract.
