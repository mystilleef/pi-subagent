# Subagent

This `pi` extension provides a `subagent` tool designed for the
[SPAE Framework](https://github.com/mystilleef/spae-framework).

## Installation

```sh
pi install npm:@mystilleef/pi-subagent
```

## Features

- **Asynchronous:** Agents always run in background.
- **Parallel:** Run more than one agents simultaneously.
- **Simplicity:** No advanced orchestration workflows.
- **Bloat-free:** No pre-installed agents.

## Usage

Invoke an agent with:

```text
/run agent [optional task]
```

Stop running agents with:

```text
/cancel-subagent
```

## Workflow

The [SPAE Framework](https://github.com/mystilleef/spae-framework) emphasizes a structured workflow.

| Phase | Agent                     | Purpose                                       |
| ----- | ------------------------- | --------------------------------------------- |
| 1     | `/run spec <requirement>` | Distill requirements into `SPEC.md`           |
| 2     | `/run plan`               | Decompose `SPEC.md` into an atomic task graph |
| 3     | `/run inspect`            | Perform gap analysis and optimize `PLAN.md`   |
| 4     | `/run build`              | Carry out tasks from `PLAN.md`                |
| 5     | `/run verify`             | Verify implementation against `SPEC.md`       |

Visit the [SPAE Framework](https://github.com/mystilleef/spae-framework) for pre-packaged agents and their associated skills.
