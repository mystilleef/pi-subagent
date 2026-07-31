# ORIENT

## Mission

- `Pi` extension layers isolate child-agent execution onto host sessions
  while preserving context separation, live activity, cancellation, job
  visibility, and parent-facing results.
- Evidence: `README` plus cross-module source inspection. No `ADRs` or
  design corpus present; claims derive from source structure.

## Runtime shape

- Registration façade receives host events, slash commands, typed-tool
  calls, and custom renderer calls.
- Interactive and tool ingress converge at `startSubagentJob`; renderer
  adapters consume custom messages rather than launch paths.
- Agent discovery and resource resolution prepare validated
  `AgentConfig` data plus concrete child inputs.
- Orchestration owns lifecycle policy, `RunJob` records, progress
  seeding, parent updates, result messaging, and completion alerts.
- Child runtime owns `Pi` invocation, prompt setup, event parsing,
  mutable result accumulation, cancellation, and process-tree cleanup.
- Projection layers turn runtime data into sanitized details, tool
  payloads, progress cards, result cards, job views, and desktop
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
   updates usage/output, and emits sanitized incremental details.
7. Terminal routing classifies outcome (completion, failure,
   cancellation), sends custom result message, finalizes progress,
   clears registry state, releases resources, and triggers eligible
   alerts.

## Cross-boundary contracts

| Carrier             | Role                                    |
| ------------------- | --------------------------------------- |
| `AgentConfig`       | Validated agent policy for child setup. |
| `RunJob` + progress | Request identity and cancel ownership.  |
| `RuntimeResult`     | Accumulates message, usage, and output. |
| `SingleResult`      | Result envelope across pipeline.        |
| `SubagentDetails`   | Transports tool updates and messages.   |
| `StreamingProgress` | Tree with `ToolActivity` for updates.   |

## Ownership boundaries

- **Registration**: adapter wiring; launch policy belongs downstream.
- **Discovery and cache**: markdown parsing, `frontmatter` validation,
  user/project precedence, snapshot trust, and completion lookup.
- **Resource resolution**: converts named skills and extensions into
  child inputs before process launch.
- **Orchestration**: job registration, trust gate, scheduling split,
  merged cancel signal, progress ownership, result routing, and alert
  policy.
- **Child runtime**: `Pi` arguments, temporary prompt lifecycle, `JSON`
  event stream, raw messages, runtime limits, sleep inhibition, and
  termination.
- **Progress and output**: projection, normalization, summary
  derivation, transcript visibility control, and `UI` rendering.
- **Notifications**: terminal progress feeds request construction;
  detached platform delivery never affects lifecycle outcome.

## Architectural constraints

- Funnel every launch through `startSubagentJob`; alternate entry paths
  must keep identical job, progress, cancellation, and result semantics.
- Preserve separate live-update and terminal-result channels.
  `renderedByMessage` prevents duplicate terminal cards.
- Keep raw transcripts, `stderr`, and termination internals behind
  details sanitizers. Debug requests require host authorization; display
  paths redact sensitive values.
- Preserve `ToolActivity` nesting. Flattening loses delegated-child
  visibility.
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

## Change vectors

- **Launch behavior**: extend orchestration while maintaining thin
  adapters.
- **Child event**: extend parser, runtime accumulation, progress
  projection, sanitizer, and renderer chain together.
- **Result field**: extend shared contracts before child, orchestration,
  and presentation consumers.
- **Discovery input**: extend parser validation, cache snapshots, and
  child invocation assembly as one route.
- **Notification channel**: extend notification request model before
  platform delivery adapters.

## Evidence

- `README`: public extension purpose, ingress model, agent definition
  model, and security posture.
- Source groups: registration; discovery/cache/resource resolution;
  orchestration; child execution/termination; progress/output;
  notification delivery.
- Repository scan: no `ADRs` or design documents found.
