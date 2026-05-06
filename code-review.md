# Code Review Summary

- Reviewed core `src/` implementation plus `AGENTS.md`.
- No files modified.
- Static analysis not run: no shell executor exposed; scripts detected in `package.json`.

## Findings

### High: Subagent depth limit violates project safeguard

**Location:** `src/process.ts:27`

```ts
const MAX_SUBAGENT_DEPTH = 3;
```

**Finding:** This violates `AGENTS.md:78-79`, which requires subagent execution to stop at depth `1`.

**Suggestion:** Set max depth to `1`; update tests and README to match.

### High: Failure detection ignores `errorMessage`

**Location:** `src/index.ts:116`

```ts
result.stopReason === "aborted" ||
detectMessageError(result.messages ?? [])
```

**Finding:** Failure detection ignores `result.errorMessage`, although `src/process.ts:266` records assistant error messages there.

**Suggestion:** Include `!!result.errorMessage` in `hasSubagentFailed`.

### Medium: Agent discovery can throw on invalid frontmatter

**Location:** `src/agents.ts:78`

```ts
parseFrontmatter<Record<string, string>>(content);
```

**Finding:** Invalid YAML or non-string `tools`/`skills` values can throw during discovery before project-agent confirmation.

**Suggestion:** Wrap frontmatter parsing and field normalization per file; skip invalid agents with diagnostics.

## Priority

One change would help most: enforce depth `1` and align tests/docs with the safeguard.
