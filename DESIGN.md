# Subagent UI Card Design

This guide details the separation of concerns between subagent progress tracking and result reporting.

## UI Cards

### Progress UI Card
- Displays real-time subagent execution status.
- Shows the single-sentence outcome summary from the `complete` tool when available.
- Falls back to a normalized one-liner from the text output.
- Queries state managed in [progress-state.ts](file:///home/lateef/Projects/pi-subagent/src/progress/progress-state.ts).
- Rendered by [progress.ts](file:///home/lateef/Projects/pi-subagent/src/progress/progress.ts).

### Result UI Card
- Shows the subagent's actual detailed final result.
- Renders the complete multiline output, including thinking warning blocks.
- Bypasses progress-related summaries, truncations, or outcome transformations.
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

### Key Principles for Future Changes
- Maintain absolute separation between the `outcome` summary and the detailed `finalOutput`.
- Do not reuse progress-specific text formatters for the result card message payload.
- Display raw subagent output directly on the result card; do not fall back to the complete tool outcome.

