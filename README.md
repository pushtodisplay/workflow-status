# Workflow Status

Live per-job reporting for your [Push to Display](https://pushtodisplay.com) board. Add two lines to every job and your board fills in as the run progresses:

```
[Backend Pipeline][detect-changes]
dev · abc1234
```

…then, as each job finishes, the board refreshes with the whole run:

```
Backend Pipeline · dev · abc1234
2/4 jobs ok · started 2026-09-08 02:43:06 UTC
✓ detect-changes · 12s
✗ build-and-test (this job) · 10m 51s
  ✓ Initialize containers
  ✓ Run actions/checkout@v4.2.0
  ✗ Deploy reports to self-hosted server · 3s
◌ Build Docker Image (matrix) · 2 legs running
⏭ Apply tag
```

Runs as a `node20` action (the runner's bundled Node — no system Node required) and talks to the same Push to Display API as [`pushtodisplay/action`](https://github.com/pushtodisplay/action).

## Usage

Declare the credentials once at the workflow level (they are inherited by every job), then add a **start** report as each job's first step and an **end** report as its last step:

```yaml
env:
  PUSH_TO_DISPLAY_API_KEY: ${{ secrets.PUSH_TO_DISPLAY_API_KEY }}
  PUSH_TO_DISPLAY_BOARD: ${{ vars.PUSH_TO_DISPLAY_BOARD }}
  GITHUB_TOKEN: ${{ github.token }}    # for the end report's API read

jobs:
  build-and-test:
    steps:
      - name: Report to display (start)
        uses: pushtodisplay/workflow-status@v1
        with:
          phase: start
      - run: dotnet build
      - run: dotnet test
      - name: Report to display (end)
        if: always()
        uses: pushtodisplay/workflow-status@v1
        with:
          phase: end
          steps-json: ${{ toJSON(steps) }}
```

### Inputs

| Input | Required | Purpose |
|---|---|---|
| `phase` | ✓ `start`\|`end` | start = first step of the job; end = last step, `if: always()` |
| `api-key` | optional | Falls back to `env.PUSH_TO_DISPLAY_API_KEY` (workflow- or job-level) |
| `board-id` | optional | Falls back to `env.PUSH_TO_DISPLAY_BOARD`; omit to use the account's default board |
| `api-url` | optional | Default `https://api.pushtodisplay.com` |
| `panel-id` | optional | Explicit panel ID (1–4), overrides branch-based resolution |
| `prd-panel` / `dev-panel` | optional | Panels for prd / other branches (defaults 1 / 2) |
| `prd-branch` | optional | Branch treated as production (default `main`) |
| `label` | optional | Label shown on the board (defaults to the workflow name) |

## How it works

- **`phase: start`** — a "[workflow][job]" banner, built from runner env only (no GitHub API call).
- **`phase: end`** — reads the run's jobs and steps from the GitHub Actions API (via `GITHUB_TOKEN`) and renders a full snapshot: every job, the own job expanded step-by-step, failed steps of other failed jobs.
- **`steps-json`** — the own job's exact result: pass `${{ toJSON(steps) }}` so the action uses the caller's `steps` context (computed by GitHub itself) instead of inferring the job's conclusion. Without it the action falls back to API-derived data and logs a warning.
- The own job's result is derived from its step conclusions (the job is still `in_progress` in the API while the report step runs).
- Matrix/matrix-templated job names render as `(matrix)`, each leg reports independently.

## Cost & bounds

- **Start**: zero GitHub API calls + 1 POST. **End**: 1 GitHub API call + 1 POST.
- Everything is time-boxed inside the action (30s bound) and **fail-soft**: any error becomes a warning annotation and a small fallback block — the workflow never turns red because of reporting.

## Notes

- The **end** report must be the **last step** of the job, with `if: always()`.
- Cancelled mid-job runs end at the last completed report (a cancelled job's remaining steps don't run).
- No `permissions:` block needed: the default `GITHUB_TOKEN` can read run jobs. If a 403 appears, the fallback block explains how to add `permissions: actions: read`.
