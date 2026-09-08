# Workflow Status

Live per-job reporting for your [Push to Display](https://pushtodisplay.com) board. Add two lines to every job and your board fills in as the run progresses:

```
🚀 Backend Pipeline started
dev · abc1234
```

…then, as each job finishes, the board refreshes with the whole run:

```
Backend Pipeline · dev · abc1234
2/4 jobs ok · started 11m ago
✓ detect-changes · 12s
✗ build-and-test (this job) · 10m 51s
  ✓ Initialize containers
  ✓ Run actions/checkout@v4.2.0
  ✗ Deploy reports to self-hosted server · 3s
◌ Build Docker Image (matrix) · 2 legs running
⏭ Apply tag
```

Built on [`pushtodisplay/action`](https://github.com/pushtodisplay/action): this action renders the board message, the base action posts it.

## Usage

Set an `env` line per job (or pass `api-key` / `board-id` per step), then add a **start** report as the first step and an **end** report as the last step:

```yaml
jobs:
  build-and-test:
    env:                                              # one line per job
      PUSH_TO_DISPLAY_API_KEY: ${{ secrets.PUSH_TO_DISPLAY_API_KEY }}
      PUSH_TO_DISPLAY_BOARD: ${{ vars.PUSH_TO_DISPLAY_BOARD }}
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
```

### Inputs

| Input | Required | Purpose |
|---|---|---|
| `phase` | ✓ `start`\|`end` | start = first step of the job; end = last step, `if: always()` |
| `api-key` | optional | Falls back to job env `PUSH_TO_DISPLAY_API_KEY` |
| `board-id` | optional | Falls back to job env `PUSH_TO_DISPLAY_BOARD`; omit to use the account's default board |
| `api-url` | optional | Default `https://api.pushtodisplay.com` |
| `panel-id` | optional | Explicit panel ID (1–4), overrides branch-based resolution |
| `prd-panel` / `dev-panel` | optional | Panels for prd / other branches (defaults 1 / 2) |
| `prd-branch` | optional | Branch treated as production (default `main`) |
| `label` | optional | Label shown on the board (defaults to the workflow name) |

## How it works

- **`phase: start`** — a "🚀 \<workflow\> started" banner, built from runner env only (no GitHub API call).
- **`phase: end`** — reads the run's jobs and steps from the GitHub Actions API and renders a full snapshot: every job, the own job expanded step-by-step (its result derived from step conclusions), failed steps of other failed jobs.
- The own job's result is derived from its step conclusions (the job is still `in_progress` in the API while the report step runs).
- Matrix/matrix-templated job names render as `(matrix)`, each leg reports independently.

## Cost & bounds

- **Start**: zero GitHub API calls + 1 POST. **End**: 1 GitHub API call + 1 POST.
- Everything is time-boxed inside the action (30s bound) and **fail-soft**: any error becomes a warning annotation and a small fallback block — the workflow never turns red because of reporting.

## Notes

- The **end** report must be the **last step** of the job, with `if: always()`.
- Cancelled mid-job runs end at the last completed report (a cancelled job's remaining steps don't run).
- No `permissions:` block needed: the default `GITHUB_TOKEN` can read run jobs. If a 403 appears, the fallback block explains how to add `permissions: actions: read`.
