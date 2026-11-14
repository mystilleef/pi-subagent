# ORIENT

## Mission

- `Pi` extension layers isolate child-agent execution onto host sessions
  while preserving context separation, live activity, cancellation, job
  visibility, usage accounting, and parent-facing results.
- Layered adapter-to-orchestrator-to-child topology (`inferred`): thin
  host adapters funnel into central orchestration, child process
  runtime, and shared projection pipelines.
- Evidence: `README.md`, inline module docstrings, and cross-module
  source inspection; no `ADRs` or standalone architecture corpus exist.

## Runtime shape

- Registration façade receives host events, slash commands (`/run`,
  `/cancel-subagent`, `/jobs`, `/stats`), typed-tool calls, and custom
  renderer calls.
- Interactive and tool ingress converge at `startSubagentJob`; renderer
  adapters consume custom messages (`subagent-progress`,
  `subagent-result`), tool results, and command boards rather than
  launch paths.
- Agent discovery and resource resolution prepare validated
  `AgentConfig` data plus concrete child inputs.
- Orchestration owns lifecycle policy, `RunJob` records, module-level
  usage-ledger accounting, progress seeding, parent updates, result
  messaging, and completion alerts.
- Child runtime owns `Pi` invocation, prompt setup, event parsing,
  mutable result accumulation, cancellation, and process-tree cleanup.
- Projection layers (`progress`, `output`) turn runtime and ledger state
  into sanitized details, tool payloads, unified status cards, `/jobs`
  and `/stats` boards, display-only live activity rows, and desktop
  notifications.

## Request lifecycle

1. Host events refresh workspace context; interactive and tool requests
   enter single orchestration route.
2. Discovery merges user and nearest-project agent definitions (project
   names take precedence on collision). Snapshot-backed caches protect
   scoped reuse.
3. `UI` project selection pauses for trust decision. Preparation creates
   request identity, instance label, cancellation link, registry record,
   progress record, and details builder.
4. Root launches schedule lifecycle work and return started handle;
   nested launches await completion for parent tool output.
5. Child setup resolves prompt, skills, extensions, model settings, and
   thinking display before `JSON`-mode `Pi` execution.
6. Event handling appends or rebuilds messages, derives tool activity,
   updates usage/output, extracts child `SubagentDetails.usageTree`
   snapshots from native partial (`tool_execution_update`) and terminal
   (`subagent` `toolResult`) channels, projects role-tagged live
   activity pieces, renders bounded trees on expanded progress cards,
   and emits sanitized incremental details.
7. Terminal routing classifies outcome (completion, failure,
   cancellation), reconciles and snapshots `SubagentDetails.usageTree`,
   persists depth-zero root `subagent-usage` custom entries until
   `session_shutdown`, sends `subagent-result` messages, marks result
   posting (`markProgressResultPosted`) to suppress superseded live
   progress cards without erasing retained state, finalizes progress,
   clears registry state, releases resources, and triggers eligible
   alerts.

## Cross-boundary contracts

| Carrier                     | Role                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `AgentConfig`               | Validated agent policy for child setup.                                                                                              |
| `RunJob` + progress         | Request identity and cancel ownership.                                                                                               |
| `RuntimeResult`             | Accumulates message, usage, and output.                                                                                              |
| `SingleResult`              | Result envelope across pipeline (`usage` stays self-only).                                                                           |
| `SingleResult.usage`        | Self-only usage metrics for result cards and model-facing output.                                                                    |
| `SubagentDetails`           | Transports sanitized tool updates, messages, and `usageTree` across native channels.                                                 |
| `SubagentDetails.usageTree` | Bounded (`50`-node) accounting-only `UsageInstanceNode` tree with `omitted` totals; every details payload of an instance carries it. |
| `StreamingProgress`         | Tree with `ToolActivity` for updates.                                                                                                |
| `CardAnatomy`               | Unified card layout (`status`, `title`, `metadata`, optional `blocks`, optional `footer`) shared across all card surfaces.           |
| `RunsBoardUsage`            | Joins session rollup and per-job `UsageInstanceNode` subtrees with `/jobs` progress state.                                           |

## Ownership boundaries

- **Registration**: adapter wiring (`resources_discover`,
  `session_start` restoration across complete `getEntries()`,
  `session_shutdown` persistence cutoff, `/run`, `/cancel-subagent`,
  `/jobs`, and `/stats` dispatch); launch policy belongs downstream.
- **Discovery and cache**: markdown parsing, `frontmatter` validation,
  user/project precedence, snapshot trust, and completion lookup.
- **Resource resolution**: converts named skills and extensions into
  child inputs before process launch.
- **Orchestration**: job registration, module-level usage ledger
  (instance/subtree ownership, bounded snapshots, terminal
  reconciliation, guarded persistence/restoration, immutable queries),
  trust gate, scheduling split, merged cancel signal, progress
  ownership, result routing, and alert policy.
- **Child runtime**: `Pi` arguments, temporary prompt lifecycle, `JSON`
  event stream, raw messages, native partial/terminal `usageTree`
  extraction, runtime limits, sleep inhibition, and termination.
- **Progress and output**: unified card assembly (`renderCard`,
  `renderStatusCard`), centralized semantic styling (`semantic-style`),
  `notifyBoard` board rendering (`runs-board`, `stats-board`),
  display-only live activity projection (`activity-display`),
  result-posted live-card suppression (`postedResultIds`), projection,
  normalization, summary derivation, self-only `SingleResult.usage` card
  footers, descendant tallies (`createDescendantTally`), transcript
  visibility control, and `UI` rendering.
- **Notifications**: terminal progress feeds request construction;
  detached platform delivery never affects lifecycle outcome.

## Architectural constraints

- Funnel every launch through `startSubagentJob`; alternate entry paths
  must keep identical job, progress, cancellation, and result semantics.
- Preserve separate live-update and terminal-result channels:
  `renderedByMessage` prevents duplicate terminal cards, while
  `markProgressResultPosted` suppresses superseded live progress cards
  only after `subagent-result` delivery without deleting retained
  `/jobs` state. Never hide live cards on terminal status alone (root
  cancellations emit no result message and remain visible).
- Keep raw transcripts, `stderr`, and termination internals behind
  details sanitizers. Debug requests require host authorization; display
  paths redact sensitive values.
- Keep live activity path shortening and role tagging display-only in
  `activity-display`; never mutate stored `ToolActivity` or
  `activityText`, and evaluate `SENSITIVE_PATTERN` before shortening.
- Preserve `ToolActivity` nesting. Flattening loses delegated-child
  visibility.
- Route card layout through `renderCard`/`renderStatusCard`, board
  notifications through `notifyBoard` (re-rendered two columns narrower
  so padding avoids wrapping background bars), and styling through
  `semantic-style` roles. Omit `run` cost from descendant tallies while
  running or on `/stats` run cards whose metadata already carries
  subtree totals.
- Keep snapshot validation before deriving scoped discovery caches;
  direct cache reuse risks stale user/project splits.
- Keep agent settings ahead of parent defaults. Provider-only
  `frontmatter` rejects during discovery; model/thinking display
  resolution may clamp while child arguments keep requested thinking.
- Append completion contract after agent prompt delivery. Outcome
  extraction depends on assistant tool-call arguments, not tool-result
  payloads.
- Treat `agent_end` as graceful-termination trigger, not immediate
  success. Route process shutdown through child termination helpers,
  including tree escalation.
- Keep root background scheduling distinct from nested awaiting; parent
  tool semantics depend on that split.
- Keep `SubagentDetails.usageTree` strictly accounting-only: validate
  trees at trust boundaries (child stream ingest, session restore),
  reject unknown fields and duplicate identities, and exclude prompts,
  transcripts, and `stderr` regardless of host debug authorization.
- Assume one session per extension instance: pi reloads extensions per
  session runtime and turns the old instance's API stale after
  `session_shutdown`; the ledger keeps no session identity.
- Propagate descendant snapshots solely through native
  `tool_execution_update` (partial details) and `subagent` `toolResult`
  (terminal details) channels; attach subtrees by request `id`
  independently of `ToolActivity` nesting.
- Enforce the `50`-explicit-node bound (`MAX_USAGE_SNAPSHOT_NODES`) on
  serialized `SubagentDetails.usageTree` and persisted `subagent-usage`
  snapshots while preserving exact `omitted` totals (`count`, `totals`).
- Keep `SingleResult.usage` self-only and preserve existing result
  cards, host footer behavior, and privacy/orchestration constraints.

## Change vectors

- **Launch behavior**: extend orchestration while maintaining thin
  adapters.
- **Child event**: extend parser, runtime accumulation, progress
  projection, sanitizer, and renderer chain together.
- **Result field**: extend shared contracts before child, orchestration,
  and presentation consumers.
- **Card, board, or activity surface**: extend `semantic-style` roles,
  `renderCard`/`notifyBoard` layout primitives, `activity-display`, and
  `progress-format` projections together rather than styling inline in
  adapters.
- **Discovery input**: extend parser validation, cache snapshots, and
  child invocation assembly as one route.
- **Notification channel**: extend notification request model before
  platform delivery adapters.

## Evidence

- `README.md`: public extension purpose, ingress model, agent
  definition model, and security posture.
- Source groups (`src/`): registration (`index.ts`), discovery/cache
  (`agent/`), shared contracts/accounting/resources (`shared/`),
  orchestration/ledger/commands (`orchestration/`), child
  execution/termination (`child/`), progress/activity projection
  (`progress/`), unified cards/boards/styling (`output/`), and
  notification delivery (`notification/`).
- Repository scan: no `ADRs` or standalone architecture docs found.
