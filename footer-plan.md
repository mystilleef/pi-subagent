# Subagent Result Footer Plan

## Goal

Change the subagent result UI footer to show stats in this order:

```text
model · context tokens · turns · duration · cost
```

Example:

```text
provider/model:high · ctx:38k · 3 turns · 1.2s · $0.0120
```

## Scope

Modify only the subagent result card footer rendering path.

Keep `formatUsageStats()` unchanged so other UI paths keep their current behavior.

## Implementation

Update `src/ui.ts`:

1. Add `formatDuration(ms: number): string`.
   - `<1000ms` → `850ms`
   - `<60s` → `1.2s`
   - `>=60s` → `1m 05s`
2. Add a result-specific footer formatter, such as:

   ```ts
   export function formatResultFooter(
     usage: UsageStats,
     model?: string,
     durationMs?: number,
   ): string
   ```

3. Build footer parts in this exact order:
   - `model`, when present
   - `ctx:${formatTokens(usage.contextTokens)}`, when `contextTokens > 0`
   - `1 turn` / `N turns`, when `turns > 0`
   - formatted duration, when `durationMs` has a numeric value
   - `$${usage.cost.toFixed(4)}`, when `cost > 0`
4. Replace the subagent result footer call:

   ```ts
   const usageStr = formatUsageStats(r.usage, r.model, true);
   ```

   with:

   ```ts
   const usageStr = formatResultFooter(r.usage, r.model, r.durationMs);
   ```

## Tests

Update `test/ui.test.ts` result footer expectations.

Add or adjust coverage for the full requested order:

```text
provider/model:high · ctx:38k · 3 turns · 1.2s · $0.0120
```

Verify that the result footer no longer shows input/output tokens.

## Verification

Run targeted UI tests first:

```sh
bun test test/ui.test.ts
```

Then run broader verification if needed:

```sh
bun verify
```
