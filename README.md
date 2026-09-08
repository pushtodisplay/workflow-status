# Workflow Status

Live GitHub Actions job status on your [Push to Display](https://pushtodisplay.com) board, reported **from inside each job** — one step, any position, own job only.

No GitHub API. No `GITHUB_TOKEN`. No rate limits. No permissions. Runs as a `node20` action (the runner's bundled Node — no system Node required) and talks to the same Push to Display API as [`pushtodisplay/action`](https://github.com/pushtodisplay/action).

## How it works

Add one report step to a job. The step reacts to where it is:

- **First step of the job** — nothing has run yet → pushes a "job started" banner (built from runner env only).
- **Any later step** — pushes the job's own record: verdict + every user step that already has a result (progress if mid-job, the full record if last).
- **`if: always()`** on the last step → the record is pushed even after failures.

The job's step results come from the calling workflow's `steps` context (`${{ toJSON(steps) }}`) — computed by GitHub itself, exact by construction. Step ids are GitHub's own normalization of step names (lowercased, `-` separators); the report step itself and the runner's machinery (`Set up job`, `Post …`, etc.) are hidden.

## Usage

```yaml
env:
  PUSH_TO_DISPLAY_API_KEY: ${{ secrets.PUSH_TO_DISPLAY_API_KEY }}
  PUSH_TO_DISPLAY_BOARD: ${{ vars.PUSH_TO_DISPLAY_BOARD }}

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - name: Report to display
        uses: pushtodisplay/workflow-status@v1
        with:
          steps-json: ${{ toJSON(steps) }}
      - run: dotnet build
      - run: dotnet test
      - name: Report to display (end)
        if: always()
        uses: pushtodisplay/workflow-status@v1
        with:
          steps-json: ${{ toJSON(steps) }}
```

First step = "started" banner; last step with `if: always()` = the job's record. Same config both times — no `phase`, nothing to learn.

## What the board shows

```
[Backend Pipeline][build-and-test]
dev · 6c14266
✓ 6 steps
    ✓ Initialize containers
    ✓ Run actions/checkout@v4.2.0
    ✗ Run all tests (unit + integration)
    ...
```

- All text small; every message starts with `[workflow name][job name]`, then branch · commit.
- Verdict line: `✓ N steps` (green) or `✗ N steps · M failed` (red), followed by each step with its own symbol (✓ / ✗ / ✗ orange cancelled / ⏭ skipped).
- The reporter's own steps and the runner's auto steps are never shown.

## Panel selection

`panel-id` (explicit) → else: on the `prd-branch` (default `main`) → `prd-panel` (default 1), any other branch → `dev-panel` (default 2).

Each push overwrites the same panel — the board keeps only the latest message.

## Inputs

| Input | Default | Notes |
|---|---|---|
| `steps-json` | — | `${{ toJSON(steps) }}` — required for meaningful output; without it only run metadata is pushed (warning logged) |
| `api-key` | `PUSH_TO_DISPLAY_API_KEY` | |
| `api-url` | `https://api.pushtodisplay.com` | override for self-hosted |
| `board-id` | `PUSH_TO_DISPLAY_BOARD` | defaults to the account board |
| `panel-id` | — | overrides branch-based selection |
| `prd-panel` | `1` | |
| `dev-panel` | `2` | |
| `prd-branch` | `main` | |
| `label` | workflow name | |

## Failure behavior

The action never fails a workflow. Missing key, bad key, board API down, timeouts — all become a `::warning::` line and a clean exit 0. Requests are time-boxed (30s), no retries. Missing `steps-json` warns and pushes run metadata only.
