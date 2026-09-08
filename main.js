/*
 * Workflow Status — live per-job start/end workflow run reporting.
 *
 * PHASE=start: renders a "🚀 <workflow> started" banner from runner env only —
 *              no GitHub API call, so start reports cost zero rate-limit budget.
 * PHASE=end:   reads the current workflow run's jobs/steps from the GitHub
 *              Actions API and renders a full run snapshot (every job, the own
 *              job expanded step-by-step, failed steps of other failed jobs),
 *              then POSTs the rendered message to the Push to Display API.
 *
 * Fails soft: any error emits an annotation warning; process exits 0 — the
 * workflow result is never affected. No dependencies, no retries, 30s bounds.
 *
 * Reads inputs from INPUT_* env (set by the runner from action.yml inputs):
 *   INPUT_PHASE, INPUT_API_KEY, INPUT_API_URL, INPUT_BOARD_ID, INPUT_PANEL_ID,
 *   INPUT_PRD_PANEL, INPUT_DEV_PANEL, INPUT_PRD_BRANCH, INPUT_LABEL
 * plus runner env: GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
 *   GITHUB_REF, GITHUB_REF_NAME, GITHUB_HEAD_REF, GITHUB_SHA,
 *   GITHUB_WORKFLOW, GITHUB_JOB, GITHUB_TOKEN, GITHUB_OUTPUT
 * plus fallbacks: PUSH_TO_DISPLAY_API_KEY, PUSH_TO_DISPLAY_BOARD.
 */
const { appendFileSync } = require("node:fs");

const env = process.env;
const MAX_BLOCKS = 60;
const REQUEST_TIMEOUT_MS = 30_000; // the action owns its own bound

// ---------- helpers ----------

function warn(msg) {
  console.log(`::warning::Push to Display: ${msg}`);
}

function input(name) {
  return (env[`INPUT_${name.replace(/-/g, "_").toUpperCase()}`] ?? "")
    .trim();
}

function writeOutput(name, value) {
  const out = env.GITHUB_OUTPUT;
  if (!out) return;
  appendFileSync(out, `${name}<<PTD_EOF\n${value}\nPTD_EOF\n`);
}

function fmtDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return "";
  return fmtSecs(
    Math.max(
      0,
      Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000),
    ),
  );
}

function fmtSecs(secs) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const rest = secs % 60;
  if (m < 60) return `${m}m ${rest}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtUtc(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
  );
}

const JOB_STYLES = {
  success: { sym: "\u2713", color: "#22c55e" }, // ✓ green
  failure: { sym: "\u2717", color: "#ef4444" }, // ✗ red
  cancelled: { sym: "\u2717", color: "#f59e0b" }, // ✗ orange
  skipped: { sym: "\u23ed", color: "#9ca3af" }, // ⏭ grey
  queued: { sym: "\u25cc", color: "#93c5fd" }, // ◌ light blue
  in_progress: { sym: "\u25cc", color: "#3b82f6" }, // ◌ blue
};

function jobStyle(job) {
  if (job.status === "in_progress" || job.status === "queued") {
    return JOB_STYLES[job.status];
  }
  return JOB_STYLES[job.conclusion] ?? { sym: "\u25cc", color: "#9ca3af" };
}

// The API leaves ${{ ... }} templates unrendered in matrix job names.
function displayName(name) {
  return (name ?? "").replace(/\$\{\{[^}]*\}\}/g, "matrix");
}

// Steps the runner adds automatically — not user steps, hide them.
function isAutoStep(name) {
  return (
    name === "Set up job" ||
    name === "Complete job" ||
    (name ?? "").startsWith("Post ")
  );
}

// Derive the own job's conclusion: while this report step runs, the API still
// reports the job as in_progress, but every previous (user) step already has
// its final conclusion.
function deriveOwnConclusion(ownJob) {
  const steps = (ownJob.steps ?? []).filter(
    (s) => !isAutoStep(s.name) && s.status === "completed",
  );
  if (
    steps.some(
      (s) => s.conclusion === "failure" || s.conclusion === "cancelled",
    )
  ) {
    return "failure";
  }
  return "success";
}

// ---------- inputs ----------

const label = input("label") || env.GITHUB_WORKFLOW || "workflow";
const ref = env.GITHUB_REF || "";
const branch =
  env.GITHUB_HEAD_REF ||
  env.GITHUB_REF_NAME ||
  (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref);
const sha = (env.GITHUB_SHA || "").slice(0, 7);
const selfJob = env.GITHUB_JOB || "";

function resolvePanel() {
  const override = input("panel-id");
  if (override) return override;
  const prdBranch = input("prd-branch") || "main";
  return ref === `refs/heads/${prdBranch}`
    ? input("prd-panel") || "1"
    : input("dev-panel") || "2";
}

// ---------- GitHub Actions API ----------

async function listJobs(repo, runId, attempt, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pushtodisplay-workflow-status",
  };
  const base = `https://api.github.com/repos/${repo}/actions/runs/${runId}`;
  let endpoint = `${base}/attempts/${attempt}/jobs`;
  let filterByAttempt = false;
  const all = [];
  let page = 1;

  for (;;) {
    const url = `${endpoint}?per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404 && !filterByAttempt) {
      // Very old runner/API fallback: list jobs for the run, filter client-side.
      endpoint = `${base}/jobs`;
      filterByAttempt = true;
      page = 1;
      continue;
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      const hint =
        res.status === 403
          ? " — add 'permissions: actions: read' to the job"
          : "";
      throw new Error(
        `GitHub Actions API ${res.status}: ${body}${hint}`
          .replace(/\r?\n/g, " ")
          .replace(/\s+/g, " "),
      );
    }
    const data = await res.json();
    const jobs = (data.jobs ?? []).filter(
      (j) => !filterByAttempt || j.run_attempt === Number(attempt),
    );
    all.push(...jobs);
    const link = res.headers.get("link") || "";
    if (!link.includes('rel="next"') || jobs.length === 0) break;
    page += 1;
  }
  return all;
}

// ---------- rendering ----------

function startBlocks() {
  return [
    { text: `[${label}][${selfJob}]`, size: "small" },
    { text: `${branch} \u00b7 ${sha}`, size: "small", color: "#9ca3af" },
  ];
}

async function endBlocks() {
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT || "1";
  const token = env.GITHUB_TOKEN || "";

  if (!repo || !runId || !token) {
    throw new Error("missing GITHUB_REPOSITORY / GITHUB_RUN_ID / GITHUB_TOKEN");
  }

  const jobs = (await listJobs(repo, runId, attempt, token)).sort((a, b) =>
    (a.started_at ?? "").localeCompare(b.started_at ?? ""),
  );

  const blocks = [];
  const okCount = jobs.filter((j) => j.conclusion === "success").length;
  const firstStart = jobs.find((j) => j.started_at)?.started_at;
  const started = firstStart ? `\u00b7 started ${fmtUtc(firstStart)}` : "";
  blocks.push({ text: `[${label}][${selfJob}]`, size: "small" });
  blocks.push({
    text: `${branch} \u00b7 ${sha}`,
    size: "small",
    color: "#9ca3af",
  });
  blocks.push({
    text: `${okCount}/${jobs.length} jobs ok ${started}`.trim(),
    size: "small",
    color: "#9ca3af",
  });

  for (const job of jobs) {
    const own = job.name === selfJob;
    let style = jobStyle(job);
    let duration = fmtDuration(job.started_at, job.completed_at);
    if (own) {
      const conclusion = deriveOwnConclusion(job);
      style = JOB_STYLES[conclusion];
      duration = fmtDuration(job.started_at, new Date().toISOString());
    }
    blocks.push({
      text: `${style.sym} ${displayName(job.name)}${
        own ? " (this job)" : ""
      }${duration ? ` \u00b7 ${duration}` : ""}`,
      size: "small",
      color: style.color,
    });

    if (own) {
      for (const step of job.steps ?? []) {
        if (isAutoStep(step.name)) continue;
        if (step.status !== "completed") continue; // this report step
        const style2 =
          JOB_STYLES[step.conclusion] ?? { sym: "\u25cc", color: "#9ca3af" };
        const d = fmtDuration(step.started_at, step.completed_at);
        blocks.push({
          text: `  ${style2.sym} ${step.name}${d ? ` \u00b7 ${d}` : ""}`,
          size: "small",
          color: style2.color,
        });
      }
      continue;
    }

    if (job.conclusion === "failure" || job.conclusion === "cancelled") {
      for (const step of job.steps ?? []) {
        if (step.conclusion !== "failure" && step.conclusion !== "cancelled")
          continue;
        if (isAutoStep(step.name)) continue;
        const d = fmtDuration(step.started_at, step.completed_at);
        blocks.push({
          text: `  ${step.name}${d ? ` \u00b7 ${d}` : ""}`,
          size: "small",
          color: "#ef4444",
        });
      }
    }
  }

  if (blocks.length > MAX_BLOCKS) {
    blocks.splice(MAX_BLOCKS);
    blocks.push({ text: "\u2026and more", size: "small", color: "#9ca3af" });
  }
  return blocks;
}

// ---------- Push to Display API ----------

async function pushToDisplay(panelId, blocks) {
  const apiUrl = input("api-url") || "https://api.pushtodisplay.com";
  const apiKey =
    input("api-key") || env.PUSH_TO_DISPLAY_API_KEY || "";
  const boardId = input("board-id") || env.PUSH_TO_DISPLAY_BOARD || "";
  if (!apiKey) {
    warn(
      "missing API key — set the api-key input or env PUSH_TO_DISPLAY_API_KEY; no message pushed",
    );
    return;
  }

  const url = `${apiUrl}/v1/updates`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({ boardId, panelId, blocks }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if ((error && error.name) === "TimeoutError") {
      throw new Error(`Push to Display API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `Push to Display API returned ${response.status}: ${body}`
        .replace(/\r?\n/g, " ")
        .replace(/\s+/g, " "),
    );
  }
  console.log(`Push to Display: message pushed, panel ${panelId}`);
}

// ---------- main ----------

(async () => {
  try {
    const panelId = resolvePanel();
    const blocks =
      input("phase") === "start" ? startBlocks() : await endBlocks();
    writeOutput("panel-id", panelId);
    try {
      await pushToDisplay(panelId, blocks);
    } catch (pushErr) {
      // The push failing never fails the workflow.
      warn(pushErr.message);
    }
    process.exit(0);
  } catch (err) {
    warn(err.message);
    const panelId = resolvePanel();
    writeOutput("panel-id", panelId);
    process.exit(0);
  }
})();
