#!/usr/bin/env node
/*
 * Opinionated Push to Display — per-job start/end reporter.
 *
 * INPUT_PHASE=start:
 *   Renders a "🚀 <workflow> started" banner from runner env only — no GitHub
 *   API call at all, so start reports cost zero rate-limit budget.
 *
 * INPUT_PHASE=end:
 *   Reads the current workflow run's jobs/steps from the GitHub Actions API
 *   and renders a full run snapshot: every job's status, the own job expanded
 *   step-by-step (its conclusion derived from the step conclusions — the job is
 *   still technically in_progress in the API while this step runs), and failed
 *   steps of other failed jobs.
 *
 * Fails soft: any error emits an annotation warning and a small fallback
 * block, then exits 0 — the workflow result is never affected.
 *
 * Reads from the runner environment:
 *   GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_REF,
 *   GITHUB_REF_NAME, GITHUB_HEAD_REF, GITHUB_SHA, GITHUB_WORKFLOW,
 *   GITHUB_JOB, GITHUB_TOKEN, GITHUB_OUTPUT
 * plus the INPUT_* passthroughs set by action.yml.
 */
import { appendFileSync } from "node:fs";

const env = process.env;
const MAX_BLOCKS = 60;

// ---------- helpers ----------

function warn(msg) {
  console.log(`::warning::Push to Display: ${msg}`);
}

function writeOutput(blocksJson, panelId) {
  const out = env.GITHUB_OUTPUT;
  if (!out) return;
  // Heredoc form so arbitrary JSON content is safe in GITHUB_OUTPUT.
  appendFileSync(
    out,
    `blocks<<PTD_EOF\n${blocksJson}\nPTD_EOF\npanel-id=${panelId}\n`,
  );
}

function fmtDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return "";
  const secs = Math.max(
    0,
    Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000),
  );
  return fmtSecs(secs);
}

function fmtSecs(secs) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const rest = secs % 60;
  if (m < 60) return `${m}m ${rest}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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

// Derive the own job's conclusion from its step conclusions: while this
// report step runs, the API still reports the job as in_progress, but every
// previous (user) step already has its final conclusion.
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

function input(name) {
  return (env[name] ?? "").trim();
}

const label = input("INPUT_LABEL") || env.GITHUB_WORKFLOW || "workflow";
const ref = env.GITHUB_REF || "";
const branch =
  env.GITHUB_HEAD_REF ||
  env.GITHUB_REF_NAME ||
  (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref);
const sha = (env.GITHUB_SHA || "").slice(0, 7);
const selfJob = env.GITHUB_JOB || "";

function resolvePanel() {
  const override = input("INPUT_PANEL_ID");
  if (override) return override;
  const prdBranch = input("INPUT_PRD_BRANCH") || "main";
  return ref === `refs/heads/${prdBranch}`
    ? input("INPUT_PRD_PANEL") || "1"
    : input("INPUT_DEV_PANEL") || "2";
}

// ---------- GitHub Actions API ----------

async function listJobs(repo, runId, attempt, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pushtodisplay-opinionated-action",
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
      signal: AbortSignal.timeout(30_000), // the action owns its own bound
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

// ---------- start phase (no API call) ----------

function startReport() {
  const panelId = resolvePanel();
  const blocks = [
    { text: `\u{1F680} ${label} started`, size: "large", weight: "bold" },
    { text: `${branch} \u00b7 ${sha}`, size: "medium", color: "#9ca3af" },
  ];
  writeOutput(JSON.stringify(blocks), panelId);
  console.log(`Push to Display: start banner, panel ${panelId}`);
  process.exit(0);
}

// ---------- end phase ----------

async function endReport() {
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT || "1";
  const token = env.GITHUB_TOKEN || "";

  if (!repo || !runId || !token) {
    throw new Error(
      "missing GITHUB_REPOSITORY / GITHUB_RUN_ID / GITHUB_TOKEN",
    );
  }

  const panelId = resolvePanel();
  const jobs = await listJobs(repo, runId, attempt, token);
  const sorted = jobs.sort((a, b) =>
    (a.started_at ?? "").localeCompare(b.started_at ?? ""),
  );

  const blocks = [];
  const okCount = sorted.filter((j) => j.conclusion === "success").length;
  const firstStart = sorted.find((j) => j.started_at)?.started_at;
  const ago = firstStart
    ? `\u00b7 started ${fmtSecs(Math.max(0, Math.round((Date.now() - Date.parse(firstStart)) / 1000)))} ago`
    : "";
  blocks.push({
    text: `${label} \u00b7 ${branch} \u00b7 ${sha}`,
    size: "small",
  });
  blocks.push({
    text: `${okCount}/${sorted.length} jobs ok ${ago}`.trim(),
    size: "small",
    color: "#9ca3af",
  });

  for (const job of sorted) {
    const own = job.name === selfJob;
    let style = jobStyle(job);
    let duration = fmtDuration(job.started_at, job.completed_at);
    if (own) {
      // The job is still in_progress in the API while this report step runs —
      // derive its result from the step conclusions instead.
      const conclusion = deriveOwnConclusion(job);
      style = JOB_STYLES[conclusion];
      duration = fmtDuration(job.started_at, new Date().toISOString());
    }
    blocks.push({
      text: `${style.sym} ${displayName(job.name)}${
        own ? " (this job)" : ""
      }${duration ? ` \u00b7 ${duration}` : ""}`,
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

  writeOutput(JSON.stringify(blocks), panelId);
  console.log(
    `Push to Display: ${okCount}/${sorted.length} jobs, panel ${panelId}, ${blocks.length} blocks`,
  );
}

// ---------- main ----------

try {
  if (input("INPUT_PHASE") === "start") {
    startReport();
  } else {
    await endReport();
  }
} catch (err) {
  warn(err.message);
  const panelId = resolvePanel();
  writeOutput(
    JSON.stringify([
      { text: `\u26a0 Push to Display: ${err.message}`, color: "#f59e0b" },
    ]),
    panelId,
  );
  process.exit(0);
}
