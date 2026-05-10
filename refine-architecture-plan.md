# Refine Architecture Plan

## Goal

Keep the current subagent model: isolated child `pi --json` processes, cancellable jobs, parent-facing summaries, and debug-gated diagnostics. Address risks through small, behavior-preserving seams.

## Scope

### In scope

- Split oversized responsibilities in `src/run.ts`.
- Add a typed adapter around child `pi --json` events.
- Clarify user/project agent name collision behavior.
- Extract result-format prompt text from `src/process.ts`.
- Preserve current public behavior unless explicitly approved.

### Out of scope

- Replacing child process isolation.
- Changing `/run` UX broadly.
- Reworking agent discovery from scratch.
- Modifying cancellation semantics.
- Any implementation during proposal review.

## Phased Plan

### Phase 1: Stabilize child protocol parsing

**Risk addressed:** Child protocol parsing relies on JSON event shapes plus heuristics.

Add a small adapter module, likely:

- `src/child-events.ts`

Responsibilities:

- Parse raw JSON lines safely.
- Normalize known event types:
  - `message_end`
  - `tool_result_end`
  - `agent_end`
- Return typed results:
  - valid known event
  - valid unknown event
  - invalid JSON
- Keep process orchestration in `src/process.ts`.

Minimum viable adapter:

```ts
type ChildEventParseResult =
  | { kind: "known"; event: ChildKnownEvent }
  | { kind: "unknown"; event: unknown }
  | { kind: "invalid"; line: string };
```

Avoid:

- No full protocol state machine.
- No speculative support for future event types.
- No behavioral changes to output handling.

Tests:

- Known event normalization.
- Unknown event passthrough.
- Invalid JSON ignored safely.
- Existing `process.test.ts` still passes.

### Phase 2: Split `src/run.ts` by responsibility

**Risk addressed:** `src/run.ts` carries schema, cache, progress patching, UI dispatch, worker orchestration, result sanitation, and `/run` parsing.

Suggested extraction:

#### `src/run-command.ts`

Owns slash command concerns:

- `parseRunArgs`
- usage errors
- command handler wrapper
- completions bridge if needed

#### `src/subagent-orchestrator.ts`

Owns job lifecycle:

- `startSubagentJob`
- `runSubagentWorker`
- cancellation wiring
- parent model/thinking capture
- request id creation
- worker scheduling

#### `src/result-details.ts`

Owns result shaping:

- debug-gated details
- raw message/stderr omission
- failure detection helpers

#### `src/agent-cache.ts`

Owns cached discovery:

- cache key
- TTL handling
- reset helper
- completions lookup

Keep current exports stable where tests or extension registration depend on them. Re-export from `src/run.ts` temporarily if needed.

Tests:

- Move tests gradually, not all at once.
- Keep public import paths passing during transition.
- Run `bun verify` after each phase.

### Phase 3: Make agent name precedence explicit

**Risk addressed:** User/project agent name collisions silently favor project agents.

Recommended initial behavior: **warn, do not break**.

Why:

- Preserves existing behavior.
- Gives users visibility.
- Avoids sudden failure in existing workflows.
- Leaves room for stricter behavior later.

Proposed behavior:

- Discovery still returns project-local agent first.
- When both user and project agents share a name:
  - completions can annotate duplicate names if UI supports it
  - `/run` can show a notice before launch:
    - `Using project agent "reviewer"; user agent with same name also exists.`
- Documentation states precedence clearly.

Future option:

- Add explicit scoped names:
  - `/run project/reviewer`
  - `/run user/reviewer`

Do not add scoped names in first pass unless user approves broader UX change.

Tests:

- Collision discovery case.
- Project precedence retained.
- Warning emitted once per invocation.

### Phase 4: Extract prompt contract

**Risk addressed:** Result formatting instructions live inside `src/process.ts`.

Add a small module:

- `src/prompt-contract.ts`

Responsibilities:

- Build standardized child prompt suffix.
- Keep result-format instructions centralized.
- Expose simple function:

```ts
export function appendSubagentResultContract(prompt: string): string;
```

Benefits:

- Easier tests.
- Cleaner process spawning code.
- Safer future edits to result format.

Tests:

- Task prompt includes task prefix plus contract.
- No-task prompt includes system-following instruction plus contract.
- Contract text remains stable unless intentionally updated.

## Global State Handling

**Risk addressed:** Discovery cache, progress store, and run registry use global mutable state.

Recommendation: keep globals, but tighten boundaries.

Actions:

- Keep cache reset helpers for tests.
- Keep registry APIs as only mutation path.
- Avoid direct mutation outside owning modules.
- Document lifecycle assumption: one extension process owns runtime state.
- Add focused tests for concurrent job ids and cache isolation where gaps exist.

Do not introduce dependency injection containers or large state managers. Current runtime does not need that complexity.

## Proposed Implementation Order

1. Add child event adapter.
2. Add tests for adapter.
3. Wire `src/process.ts` through adapter.
4. Split result-details helpers from `src/run.ts`.
5. Split agent cache helpers.
6. Split command parsing/handler helpers.
7. Split orchestration last.
8. Add collision warning and docs.
9. Extract prompt contract.
10. Run full `bun verify`.

This order reduces protocol fragility first, then lowers `src/run.ts` complexity in small steps.

## Acceptance Criteria

- `bun verify` passes.
- `/run <agent> [task]` behavior unchanged.
- `/run --debug <agent> [task]` still includes raw diagnostics.
- Non-debug results still omit raw child messages/stderr.
- Cancellation still kills process tree.
- Project-local confirmation still works.
- Nested subagent limit still blocks depth greater than `1`.
- Agent name collisions produce visible warning while preserving project precedence.
- Prompt result contract has dedicated tests.

## Vibe Check Adjustments Applied

Changed proposal after vibe check:

- Added phased sequencing instead of one large refactor.
- Recommended non-breaking collision warning first.
- Scoped typed event adapter to current protocol only.
- Deferred scoped agent names as future UX, not first-pass work.
- Kept global state instead of overengineering runtime state management.

## Recommendation

Approve this as a staged, behavior-preserving refactor plan. Start with protocol adapter and tests, then split `src/run.ts` across natural seams. This improves reliability and maintainability without changing the successful core architecture.
