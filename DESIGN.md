# Subagent UI Card Design

This guide details the separation of concerns between subagent progress tracking and result reporting.

## UI Cards

### Progress UI Card
- Displays real-time subagent execution status.
- Shows the single-sentence outcome summary from the `complete` tool when available.
- Falls back to a normalized summary via `summarizeFeedbackUiFinalOutput`: applies
  label-priority heuristics, filters generic candidates ("done", "success", etc.),
  and lowercases the result. This is the same path used by the feedback summary.
- Queries state managed in [progress-state.ts](file:///home/lateef/Projects/pi-subagent/src/progress/progress-state.ts).
- Rendered by [progress.ts](file:///home/lateef/Projects/pi-subagent/src/progress/progress.ts).

### Result UI Card
- Shows the subagent's actual detailed final result.
- Renders the complete multiline output, including thinking warning blocks.
- Bypasses progress-related summaries, truncations, or outcome transformations.
- Reads `SingleResult.finalOutput` from `details.results[0]` directly. Does not
  rescan messages — messages are stripped in non-debug mode by
  `sanitizeDetailsForDisplay`, and `finalOutput` is kept current by
  `addMessageToResult` on every incoming message.
- The `renderedByMessage: true` flag on the returned `SubagentToolResult` suppresses
  the tool-result renderer. The card renders exclusively from the `subagent-result`
  custom message dispatched by `sendSubagentResultMessage`.
- Rendered by [ui.ts](file:///home/lateef/Projects/pi-subagent/src/output/ui.ts).

## Data Flow & Orchestration

The orchestrator in [subagent-orchestrator.ts](file:///home/lateef/Projects/pi-subagent/src/orchestration/subagent-orchestrator.ts) manages these cards independently inside `finishLifecycleResult`:

```typescript
// 1. Update the progress state (uses outcome summary logic)
finalizeProgressState(
  lc.requestId,
  getFeedbackSummaryText(toolResult),
  result.outcome,
);

// 2. Dispatch the actual result directly to the result UI card (bypasses outcome summary)
sendSubagentResultMessage(lc.pi, content, displayDetails);
```

On failure, `finishLifecycleFailure` uses `formatSubagentFailureForParent` to
produce an explicit failure signal for the parent LLM:

```typescript
// "(failed) <errorMessage>\n\n<finalOutput>" when partial output exists,
// or just "<errorMessage>" when there is no result.
const content = formatSubagentFailureForParent(errorMessage, latestResult);
sendSubagentResultMessage(lc.pi, content, displayDetails);
```

### Key Principles for Future Changes
- Maintain absolute separation between the `outcome` summary and the detailed `finalOutput`.
- Do not reuse progress-specific text formatters for the result card message payload.
- Display raw subagent output directly on the result card; do not fall back to the complete tool outcome.
- `getFeedbackSummaryText` feeds the progress store only — it must never access
  `content[0].text`, which carries streaming activity text and is stale at finalization.
- `renderSubagentResult` must not rescan messages to recover `finalOutput` — the
  invariant is that `finalOutput` is always current; a missing `finalOutput` means
  the agent produced no text output and the card should render `"(no output)"`.

## Subagent Result Contract

The system appends the result contract from [prompt-contract.ts](file:///home/lateef/Projects/pi-subagent/src/child/prompt-contract.ts) to each subagent task prompt. This contract enforces structured result output from subagents.

### Directives & Constraints

- **Mandatory Completion**: The subagent must emit the task result upon completion.
- **Format**: Write result as a text response. Never wrap the entire result in one code block.
- **Commentary**: Emit result directly to the calling agent without additional commentary.
- **Outcome Summary**: Call the complete tool as the final action, providing a short, single-sentence outcome.
