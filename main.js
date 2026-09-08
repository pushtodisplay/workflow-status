/*
 * Workflow Status — own-job reporting for a Push to Display board.
 *
 * One report step per job, placed anywhere in the job:
 *   - first step (nothing has run yet): "job started" banner — env only
 *   - any later step: the job's own record — verdict + every user step that
 *     already has a result (progress or final, depending on placement)
 *
 * No GitHub API, no GITHUB_TOKEN, no permissions needed. The job's own
 * step results come from the calling workflow's steps context, passed as
 * steps-json = toJSON(steps) and computed by GitHub itself.
 *
 * Fails soft: any error emits an annotation warning; the process exits 0 —
 * the workflow result is never affected. No dependencies, no retries, 30s
 * bound on the one request the action makes (to Push to Display).
 *
 * Reads inputs from INPUT_* env (set by the runner from action.yml inputs):
 *   INPUT_STEPS_JSON, INPUT_API_KEY, INPUT_API_URL, INPUT_BOARD_ID,
 *   INPUT_PANEL_ID, INPUT_PRD_PANEL, INPUT_DEV_PANEL, INPUT_PRD_BRANCH,
 *   INPUT_LABEL
 * plus runner env: GITHUB_WORKFLOW, GITHUB_JOB, GITHUB_REF, GITHUB_REF_NAME,
 *   GITHUB_HEAD_REF, GITHUB_SHA, GITHUB_OUTPUT
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

// Inputs arrive as INPUT_<NAME> with the name uppercased (spaces → underscores)
// but hyphens KEPT — e.g. steps-json → INPUT_STEPS-JSON (@actions/core
// convention). Fall back to the hyphen→underscore form for lenient runs.
function input(name) {
  const key = name.replace(/ /g, "_").toUpperCase();
  const value =
    env[`INPUT_${key}`] ?? env[`INPUT_${key.replace(/-/g, "_")}`] ?? "";
  return value.trim();
}

function writeOutput(name, value) {
  const out = env.GITHUB_OUTPUT;
  if (!out) return;
  appendFileSync(out, `${name}<<PTD_EOF\n${value}\nPTD_EOF\n`);
}

// ---------- run facts (lazy: tests and runners may set env late) ----------

function getLabel() {
  return input("label") || env.GITHUB_WORKFLOW || "workflow";
}

function getBranch() {
  const ref = env.GITHUB_REF || "";
  return (
    env.GITHUB_HEAD_REF ||
    env.GITHUB_REF_NAME ||
    (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref)
  );
}

function getSha() {
  return (env.GITHUB_SHA || "").slice(0, 7);
}

function getSelfJob() {
  return env.GITHUB_JOB || "";
}

function resolvePanel() {
  const override = input("panel-id");
  if (override) return override;
  const prdBranch = input("prd-branch") || "main";
  return env.GITHUB_REF === `refs/heads/${prdBranch}`
    ? input("prd-panel") || "1"
    : input("dev-panel") || "2";
}

// ---------- own-job record ----------

const STEP_STYLES = {
  success: { sym: "\u2713", color: "#22c55e" }, // ✓ green
  failure: { sym: "\u2717", color: "#ef4444" }, // ✗ red
  cancelled: { sym: "\u2717", color: "#f59e0b" }, // ✗ orange
  skipped: { sym: "\u23ed", color: "#9ca3af" }, // ⏭ grey
};

// Steps that are not the user's own: runner machinery (Set up job, Post …,
// Complete job, container init/stop) and the Push to Display reporter itself.
// Steps are keyed by their (auto-generated) step id — GitHub's own
// normalization of the step name: lowercased, non-alphanumerics -> hyphens.
function isHiddenStep(key) {
  const k = (key || "").toLowerCase();
  return (
    k === "set-up-job" ||
    k === "complete-job" ||
    k === "initialize-containers" ||
    k === "stop-containers" ||
    k.startsWith("post-") ||
    k.includes("report-to-display") ||
    k.includes("push-to-display") ||
    k.includes("pushtodisplay")
  );
}

// Step ids shown verbatim as GitHub normalized them; tidy runs of hyphens.
function displayStepName(key) {
  return (key || "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function parseStepsJson() {
  const raw = input("steps-json");
  if (!raw) {
    console.log("Push to Display: steps-json input (empty)");
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    console.log(
      `Push to Display: steps-json input (${raw.length} chars): ${raw}`,
    );
    return parsed;
  } catch (error) {
    console.log(
      `Push to Display: unparsable steps-json input (${raw.length} chars): ${raw}`,
    );
    return null;
  }
}

function bannerBlocks() {
  return [
    { text: `[${getLabel()}][${getSelfJob()}]`, size: "small" },
    {
      text: `${getBranch()} \u00b7 ${getSha()}`,
      size: "small",
      color: "#9ca3af",
    },
  ];
}

function buildBlocks() {
  const stepsJson = parseStepsJson();
  if (stepsJson === null) {
    warn(
      "steps-json missing or unparsable — pass with: steps-json: ${{ toJSON(steps) }}; only run metadata pushed",
    );
    return bannerBlocks();
  }

  const terminal = Object.entries(stepsJson)
    .map(([key, value]) => ({
      key,
      conclusion: (value && (value.conclusion || value.outcome)) || null,
    }))
    .filter(
      (s) =>
        !isHiddenStep(s.key) &&
        (s.conclusion === "success" ||
          s.conclusion === "failure" ||
          s.conclusion === "cancelled" ||
          s.conclusion === "skipped"),
    );

  // Nothing has run yet: this step is the first step of the job — announce it.
  if (terminal.length === 0) return bannerBlocks();

  const failed = terminal.filter(
    (s) => s.conclusion === "failure" || s.conclusion === "cancelled",
  );
  const sym = failed.length ? "\u2717" : "\u2713";
  const color = failed.length ? "#ef4444" : "#22c55e";

  const blocks = [
    { text: `[${getLabel()}][${getSelfJob()}]`, size: "small" },
    {
      text: `${getBranch()} \u00b7 ${getSha()}`,
      size: "small",
      color: "#9ca3af",
    },
    {
      text: `${sym} ${terminal.length} steps${
        failed.length ? ` \u00b7 ${failed.length} failed` : ""
      }`,
      size: "small",
      color,
    },
  ];
  for (const step of terminal) {
    const style = STEP_STYLES[step.conclusion] ?? {
      sym: "\u25cc",
      color: "#9ca3af",
    };
    blocks.push({
      text: `  ${style.sym} ${displayStepName(step.key)}`,
      size: "small",
      color: style.color,
    });
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
  const apiKey = input("api-key") || env.PUSH_TO_DISPLAY_API_KEY || "";
  const boardId = input("board-id") || env.PUSH_TO_DISPLAY_BOARD || "";
  if (!apiKey) {
    warn(
      "missing API key — set the api-key input or env PUSH_TO_DISPLAY_API_KEY; no message pushed",
    );
    return;
  }

  const url = `${apiUrl}/v1/updates`;
  const payload = { boardId, panelId, blocks };
  console.log(
    `Push to Display: payload to send → ${url}: ${JSON.stringify(payload)}`,
  );
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if ((error && error.name) === "TimeoutError") {
      throw new Error(
        `Push to Display API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
      );
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

// Never throws, never exits non-zero: the workflow result is untouched.
async function run() {
  process.exitCode = 0;
  let panelId;
  try {
    panelId = resolvePanel();
    const blocks = buildBlocks();
    writeOutput("panel-id", panelId);
    try {
      await pushToDisplay(panelId, blocks);
    } catch (pushErr) {
      // The push failing never fails the workflow.
      warn(pushErr.message);
    }
  } catch (err) {
    warn(err.message);
    panelId = resolvePanel();
    writeOutput("panel-id", panelId);
  }
}

if (require.main === module) {
  run().finally(() => process.exit(0));
}

module.exports = {
  warn,
  input,
  writeOutput,
  getLabel,
  getBranch,
  getSha,
  getSelfJob,
  resolvePanel,
  isHiddenStep,
  displayStepName,
  parseStepsJson,
  bannerBlocks,
  buildBlocks,
  pushToDisplay,
  run,
};
