# Workflow Status

Live GitHub Actions job status on your [Push to Display](https://pushtodisplay.com) board, reported **from inside each job** — one step, any position, own job only.

No GitHub API. No `GITHUB_TOKEN`. No rate limits. No permissions. Runs as a `node20` action (the runner's bundled Node — no system Node required) and talks to the same Push to Display API as [`pushtodisplay/action`](https://github.com/pushtodisplay/action).

## How it works

Add one report step to a job. The status is derived from the calling workflow's `steps` context (`${{ toJSON(steps) }}`) — computed by GitHub itself, exact by construction:

| what the report sees | status |
|---|---|
| nothing has run yet (first step) | `● started` |
| steps ran, all succeeded (or skipped) | `✓ done` |
| steps ran, all succeeded, `progress: "true"` set | `● in progress` |
| any step failed | `✗ failed · <step ids>` |
| no failures, any step cancelled | `✗ cancelled · <step ids>` |

Failures and cancellations always win over `progress`. Missing/unparsable `steps-json` warns and pushes metadata only (fail-soft, exit 0).

The `steps` context contains only steps that declare an `id:` **and have already run** — so a report step can never see steps after it, and the runner exposes no total step count. That is why a report placed mid-job must set `progress: "true"`; otherwise it looks exactly like a final report. The reporter's own steps, the runner's machinery (`Set up job`, `Post …`, `Complete job`) and service-container steps (keyed by a runner-generated UUID) are never counted.

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

First step = `● started`; last step with `if: always()` = `✓ done` / `✗ failed`. Same config both times — no `phase`, nothing to learn. If you also report mid-job, add `progress: "true"` to that step only.

## What the board shows

```
dev · 68454e8
[Backend Pipeline][build-and-test]
✓ done
```

On failure, the failed step ids are named in the status line:

```
dev · 68454e8
[Backend Pipeline][build-and-test]
✗ failed · build, test
```

- Every message starts with `branch · commit`, then `[workflow][job]`, then the status — three blocks, all small.
- Colors follow the same palette as `compose/stg/utils/sendnotification`: text `#e8e8e8`, muted `#7f8c8d`, done `#2ecc71`, failed `#e74c3c`, cancelled `#f5b041`, started/in progress `#5dade2`, background `#2c3e50`.

## Panel selection

`panel-id` (explicit) → else: on the `prd-branch` (default `main`) → `prd-panel` (default 1), any other branch → `dev-panel` (default 2).

Each push overwrites the same panel — the board keeps only the latest message.

## Inputs

| Input | Default | Notes |
|---|---|---|
| `steps-json` | — | `${{ toJSON(steps) }}` — required for a status; without it only run metadata is pushed (warning logged) |
| `progress` | — | `"true"` on report steps placed mid-job → `● in progress` |
| `api-key` | `PUSH_TO_DISPLAY_API_KEY` | |
| `api-url` | `https://api.pushtodisplay.com` | override for self-hosted |
| `board-id` | `PUSH_TO_DISPLAY_BOARD` | defaults to the account board |
| `panel-id` | — | overrides branch-based selection |
| `prd-panel` | `1` | |
| `dev-panel` | `2` | |
| `prd-branch` | `main` | |
| `label` | workflow name | |

## Failure behavior

The action never fails a workflow. Missing key, bad key, board API down, timeouts — all become a `::warning::` line and a clean exit 0. Requests are time-boxed (30s), no retries.
