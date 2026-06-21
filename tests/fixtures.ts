export interface SummaryFixture {
  name: string;
  finalOutput: string;
  outcome?: string;
  expectedSummary: string;
  expectedProgress: string;
}

export const CANONICAL_SUMMARY_FIXTURES: SummaryFixture[] = [
  {
    name: "explicit outcome wins over finalOutput",
    finalOutput: "ignored output",
    outcome: "My Typed Outcome!",
    expectedSummary: "my typed outcome",
    expectedProgress: "my typed outcome",
  },
  {
    name: "status-only explicit outcome maps to completed task in progress",
    finalOutput: "ignored output",
    outcome: "Success",
    expectedSummary: "success",
    expectedProgress: "completed task",
  },
  {
    name: "label-prefixed result line",
    finalOutput: "Result: needs follow-up review",
    expectedSummary: "needs follow-up review",
    expectedProgress: "needs follow-up review",
  },
  {
    name: "outcome label with preamble",
    finalOutput: "noise\nOutcome: completed requested fix",
    expectedSummary: "outcome: completed requested fix",
    expectedProgress: "outcome: completed requested fix",
  },
  {
    name: "markdown heading and bullet",
    finalOutput: "## Summary:\n- Outcome: **Rendered custom card body**",
    expectedSummary: "outcome: **rendered custom card body**",
    expectedProgress: "outcome: **rendered custom card body**",
  },
  {
    name: "status-only success uppercase",
    finalOutput: "SUCCESS",
    expectedSummary: "completed task",
    expectedProgress: "completed task",
  },
  {
    name: "status-only done",
    finalOutput: "DONE",
    expectedSummary: "completed task",
    expectedProgress: "completed task",
  },
  {
    name: "generic statuses filtered",
    finalOutput: "Summary\nStatus: success\nDone",
    expectedSummary: "completed task",
    expectedProgress: "completed task",
  },
  {
    name: "label-prefixed success becomes completed task",
    finalOutput: "Status: DONE",
    expectedSummary: "completed task",
    expectedProgress: "completed task",
  },
  {
    name: "nested status and label",
    finalOutput: "SUCCESS: Result: implemented fix",
    expectedSummary: "implemented fix",
    expectedProgress: "implemented fix",
  },
  {
    name: "long text truncates at canonical limit",
    finalOutput: `Outcome: Implemented ${"semantic result ".repeat(20)}for run cards.`,
    expectedSummary:
      "outcome: implemented semantic result semantic result semantic result semantic result semantic result semantic result se…",
    expectedProgress:
      "outcome: implemented semantic result semantic result semantic result semantic result semantic result semantic result se…",
  },
];
