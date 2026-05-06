# Code Review

Static analysis: not run; harness exposed no shell/exec tool.

## Findings

### High: Greeting filter drops semantic severity lines

- Location: `src/summary.ts:35`
- Code: `return /^(?:hello|hi|hey|reasoning:|raw log:|apolog(?:y|ies)|sorry\b)/i.test(`
- Issue: `hi` lacks a word boundary, so meaningful subagent lines like `High severity...` get filtered from parent summaries.
- Suggestion: Use greeting boundaries, for example `(?:hello|hi|hey)\b`.

### Medium: Unknown tool previews may leak secrets

- Location: `src/summary.ts:31`
- Code: `return JSON.stringify(args);`
- Issue: Unknown tool previews serialize arbitrary child tool args, which can leak secrets into parent progress UI/state.
- Suggestion: Return only the tool name for unknown tools, or redact allowlisted safe fields before previewing.

## Priority

Tighten summary/progress filtering around semantic output and sensitive child-tool data.
