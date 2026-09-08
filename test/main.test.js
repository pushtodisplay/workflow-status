/*
 * Unit tests for the Workflow Status action. node --test, zero deps.
 *
 * The failure behavior is mock-tested: "the job failed, the report step
 * still runs" (if: always() on the runner) is modeled here by feeding the
 * action a steps-json whose steps carry failure/cancelled conclusions and
 * asserting the red record is rendered and posted. fetch is mocked; no
 * network, no real board, no real key.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const action = require("../main.js");

// ---------- helpers ----------

const ENV_PREFIXES = /^(INPUT_|GITHUB_|PUSH_TO_DISPLAY_)/;

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (ENV_PREFIXES.test(key)) delete process.env[key];
  }
}

function setEnv(values = {}) {
  Object.assign(process.env, values);
}

function captureLogs() {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  return {
    logs,
    restore() {
      console.log = original;
    },
  };
}

function mockFetch(impl) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return impl(url, init, calls.length);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function okResponse() {
  return { ok: true, status: 200, text: async () => "{}" };
}

function errResponse(status, body) {
  return { ok: false, status, text: async () => body };
}

test.beforeEach(() => {
  resetEnv();
  setEnv({
    GITHUB_WORKFLOW: "Backend Pipeline",
    GITHUB_JOB: "build-and-test",
    GITHUB_REF: "refs/heads/dev",
    GITHUB_REF_NAME: "dev",
    GITHUB_SHA: "abcdef1234567890",
  });
});

test.afterEach(() => {
  resetEnv();
});

// ---------- position handling ----------

test("first position (empty steps context) renders the banner", () => {
  setEnv({ INPUT_STEPS_JSON: "{}", GITHUB_JOB: "detect-changes" });
  assert.deepStrictEqual(action.buildBlocks(), [
    { text: "[Backend Pipeline][detect-changes]", size: "small" },
    { text: "dev · abcdef1", size: "small", color: "#9ca3af" },
  ]);
});

test("missing steps-json warns and falls back to the banner", () => {
  const cap = captureLogs();
  try {
    const blocks = action.buildBlocks();
    assert.deepStrictEqual(blocks, [
      { text: "[Backend Pipeline][build-and-test]", size: "small" },
      { text: "dev · abcdef1", size: "small", color: "#9ca3af" },
    ]);
    assert.ok(
      cap.logs.some((l) => l.includes("steps-json missing")),
      "expected a warning about steps-json",
    );
  } finally {
    cap.restore();
  }
});

test("unparsable steps-json warns and falls back to the banner", () => {
  setEnv({ INPUT_STEPS_JSON: "{nope" });
  const cap = captureLogs();
  try {
    assert.deepStrictEqual(action.buildBlocks(), [
      { text: "[Backend Pipeline][build-and-test]", size: "small" },
      { text: "dev · abcdef1", size: "small", color: "#9ca3af" },
    ]);
    assert.ok(cap.logs.some((l) => l.includes("steps-json missing")));
  } finally {
    cap.restore();
  }
});

// ---------- record rendering ----------

test("record: successful steps render green, runner and report steps hidden", () => {
  setEnv({
    INPUT_STEPS_JSON: JSON.stringify({
      "set-up-job": { conclusion: "success" },
      "report-to-display----start-": { conclusion: "success" },
      "initialize-containers": { conclusion: "success" },
      "run-actions-checkout-v4": { conclusion: "success" },
      "install-dependencies-and-build": { conclusion: "success" },
      "run-all-tests-unit-integration": { conclusion: "success" },
      "post-run-actions-checkout-v4": { conclusion: "success" },
      "complete-job": { conclusion: "success" },
    }),
  });
  const blocks = action.buildBlocks();
  assert.strictEqual(blocks[2].text, "\u2713 3 steps");
  assert.strictEqual(blocks[2].color, "#22c55e");
  const shown = blocks.slice(3).map((b) => b.text);
  assert.deepStrictEqual(shown, [
    "  \u2713 run-actions-checkout-v4",
    "  \u2713 install-dependencies-and-build",
    "  \u2713 run-all-tests-unit-integration",
  ]);
});

test("mocked always(): failed step renders a red record", () => {
  setEnv({
    INPUT_STEPS_JSON: JSON.stringify({
      "run-actions-checkout-v4": { conclusion: "success" },
      "install-dependencies-and-build": { conclusion: "success" },
      "run-all-tests-unit-integration": { conclusion: "failure" },
    }),
  });
  const blocks = action.buildBlocks();
  assert.strictEqual(blocks[2].text, "\u2717 3 steps \u00b7 1 failed");
  assert.strictEqual(blocks[2].color, "#ef4444");
  const failed = blocks.find((b) => b.text.includes("run-all-tests"));
  assert.strictEqual(failed.color, "#ef4444");
});

test("mocked always(): cancelled step counts as failed, rendered orange", () => {
  setEnv({
    INPUT_STEPS_JSON: JSON.stringify({
      "set-up-job": { conclusion: "success" },
      "build-and-push": { conclusion: "cancelled" },
      "complete-job": { conclusion: "success" },
    }),
  });
  const blocks = action.buildBlocks();
  assert.strictEqual(blocks[2].text, "\u2717 1 steps \u00b7 1 failed");
  const line = blocks.find((b) => b.text.includes("build-and-push"));
  assert.strictEqual(line.color, "#f59e0b");
});

test("skipped step is shown grey and does not fail the record", () => {
  setEnv({
    INPUT_STEPS_JSON: JSON.stringify({
      lint: { conclusion: "skipped" },
      build: { conclusion: "success" },
    }),
  });
  const blocks = action.buildBlocks();
  assert.strictEqual(blocks[2].text, "\u2713 2 steps");
  const line = blocks.find((b) => b.text.includes("lint"));
  assert.strictEqual(line.color, "#9ca3af");
});

test("current report step (no conclusion yet) is ignored", () => {
  setEnv({
    INPUT_STEPS_JSON: JSON.stringify({
      "run-actions-checkout-v4": { conclusion: "success" },
      "report-to-display----end-": { conclusion: null, outcome: null },
    }),
  });
  const blocks = action.buildBlocks();
  assert.strictEqual(blocks[2].text, "\u2713 1 steps");
  assert.ok(!blocks.some((b) => b.text.includes("report-to-display")));
});

test("outcome is honored when conclusion is absent", () => {
  setEnv({
    INPUT_STEPS_JSON: JSON.stringify({
      "run-all-tests-unit-integration": { outcome: "failure" },
    }),
  });
  const blocks = action.buildBlocks();
  assert.strictEqual(blocks[2].text, "\u2717 1 steps \u00b7 1 failed");
});

// ---------- panel resolution ----------

test("panel: main branch goes to prd panel, other branches to dev panel", () => {
  setEnv({ GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" });
  assert.strictEqual(action.resolvePanel(), "1");
  setEnv({ GITHUB_REF: "refs/heads/dev", GITHUB_REF_NAME: "dev" });
  assert.strictEqual(action.resolvePanel(), "2");
});

test("panel: explicit panel-id wins over branch", () => {
  setEnv({ INPUT_PANEL_ID: "3", GITHUB_REF: "refs/heads/dev" });
  assert.strictEqual(action.resolvePanel(), "3");
});

test("panel: prd-branch input overrides default main", () => {
  setEnv({
    GITHUB_REF: "refs/heads/prod",
    GITHUB_REF_NAME: "prod",
    INPUT_PRD_BRANCH: "prod",
  });
  assert.strictEqual(action.resolvePanel(), "1");
});

// ---------- push: mocked fetch ----------

test("push: posts the rendered payload with the api key", async () => {
  const fetchMock = mockFetch(() => okResponse());
  try {
    setEnv({
      INPUT_API_KEY: "test-key",
      INPUT_API_URL: "http://board.test",
      INPUT_BOARD_ID: "board-1",
    });
    const blocks = action.bannerBlocks();
    await action.pushToDisplay("2", blocks);
    assert.strictEqual(fetchMock.calls.length, 1);
    const { url, init } = fetchMock.calls[0];
    assert.strictEqual(url, "http://board.test/v1/updates");
    assert.strictEqual(init.method, "POST");
    assert.strictEqual(init.headers["X-Api-Key"], "test-key");
    const body = JSON.parse(init.body);
    assert.strictEqual(body.panelId, "2");
    assert.strictEqual(body.boardId, "board-1");
    assert.deepStrictEqual(body.blocks, blocks);
  } finally {
    fetchMock.restore();
  }
});

test("push: missing api key warns and never fetches", async () => {
  const fetchMock = mockFetch(() => okResponse());
  const cap = captureLogs();
  try {
    setEnv({ INPUT_API_URL: "http://board.test" });
    await action.pushToDisplay("2", action.bannerBlocks());
    assert.strictEqual(fetchMock.calls.length, 0);
    assert.ok(cap.logs.some((l) => l.includes("missing API key")));
  } finally {
    fetchMock.restore();
    cap.restore();
  }
});

test("push: api error throws a descriptive error (run() warns, exit stays 0)", async () => {
  const fetchMock = mockFetch(() => errResponse(401, "unauthorized"));
  try {
    setEnv({ INPUT_API_KEY: "bad", INPUT_API_URL: "http://board.test" });
    await assert.rejects(
      action.pushToDisplay("2", action.bannerBlocks()),
      /401/,
    );
  } finally {
    fetchMock.restore();
  }
});

test("push: timeout is surfaced as a clear timeout error", async () => {
  const fetchMock = mockFetch(() => {
    throw { name: "TimeoutError" };
  });
  try {
    setEnv({ INPUT_API_KEY: "k", INPUT_API_URL: "http://board.test" });
    await assert.rejects(
      action.pushToDisplay("2", action.bannerBlocks()),
      /timed out after 30s/,
    );
  } finally {
    fetchMock.restore();
  }
});

// ---------- run(): fail-soft end to end ----------

test("run(): missing key + temp output file — warns, writes panel-id, exit 0", async () => {
  const outFile = path.join(os.tmpdir(), `ptd-test-${process.pid}.txt`);
  const fetchMock = mockFetch(() => okResponse());
  const cap = captureLogs();
  try {
    setEnv({
      GITHUB_OUTPUT: outFile,
      INPUT_STEPS_JSON: JSON.stringify({
        "run-actions-checkout-v4": { conclusion: "success" },
      }),
    });
    await action.run();
    assert.strictEqual(process.exitCode, 0);
    assert.ok(cap.logs.some((l) => l.includes("missing API key")));
    const written = fs.readFileSync(outFile, "utf8");
    assert.ok(written.includes("panel-id<<PTD_EOF\n2\nPTD_EOF"));
  } finally {
    fetchMock.restore();
    cap.restore();
    fs.rmSync(outFile, { force: true });
  }
});

test("run(): push failure still writes panel-id and does not throw", async () => {
  const outFile = path.join(os.tmpdir(), `ptd-test-${process.pid}-b.txt`);
  let fetchMock;
  const cap = captureLogs();
  try {
    fetchMock = mockFetch(() => errResponse(500, "boom"));
    setEnv({
      INPUT_API_KEY: "k",
      INPUT_API_URL: "http://board.test",
      GITHUB_OUTPUT: outFile,
      INPUT_STEPS_JSON: "{}",
    });
    await action.run();
    assert.strictEqual(process.exitCode, 0);
    assert.ok(cap.logs.some((l) => l.includes("500")));
    const written = fs.readFileSync(outFile, "utf8");
    assert.ok(written.includes("panel-id"));
  } finally {
    if (fetchMock) fetchMock.restore();
    cap.restore();
    fs.rmSync(outFile, { force: true });
  }
});
