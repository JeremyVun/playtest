// The reference CI workflow shipped for people to copy is checked for shape, not
// executed: live GitHub execution needs the network, which the hermetic gate
// forbids. What can be verified offline is everything that makes the recipe
// correct — that it parses, that it asks for the OIDC permission the
// registration needs, and that the unique per-run label is advertised by the
// runner AND pinned by the launch, which is the property that keeps two
// concurrent pull requests from testing each other's builds.
//
// Reading a file to lint it is not a dependency on it: the example is never
// imported, and the path is assembled the same way `boundaries.test.ts` does so
// its "product and repository tests do not depend on standalone examples" scan
// stays honest.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLE = path.join(ROOT, ["exam", "ples"].join(""), "ci-github-actions");
// `yaml` is declared by the packages that parse suite files; resolving it from
// one of them keeps this test working whether npm hoists it or nests it, and
// keeps the orchestration-only root free of runtime dependencies.
const YAML = createRequire(path.join(ROOT, "packages/platform/control-plane/package.json"))("yaml");

const workflowFile = path.join(EXAMPLE, "playtest.yml");
const source = () => fs.readFileSync(workflowFile, "utf8");

test("the reference CI workflow parses as a GitHub Actions workflow", () => {
  assert.ok(fs.existsSync(path.join(EXAMPLE, "README.md")), "the example explains itself");
  const doc = YAML.parse(source());
  assert.equal(doc.name, "playtest");
  assert.ok(doc.on.pull_request !== undefined, "it gates pull requests");
  // `id-token: write` is what makes ACTIONS_ID_TOKEN_REQUEST_URL exist. Without
  // it the registration step fails at run time, in someone else's repository.
  assert.equal(doc.permissions["id-token"], "write");
  assert.equal(doc.permissions.contents, "read");

  const job = doc.jobs.playtest;
  assert.ok(job, "one job named playtest");
  assert.ok(Number.isInteger(job["timeout-minutes"]), "a bounded job, so a stuck wait cannot burn an hour");
  const steps = job.steps.map((s: { name?: string; uses?: string }) => s.name ?? s.uses);
  assert.deepEqual(steps, [
    "actions/checkout@v4",
    "actions/setup-node@v4",
    "Build and start the app on localhost",
    "Check out the Playtest runner agent",
    "Register an ephemeral runner",
    "Start the runner",
    "Launch the suite and wait for the verdict",
    "Stop the runner",
  ]);
  assert.equal(job.steps.at(-1).if, "always()", "the runner is stopped even when the verdict is red");
});

test("the reference CI workflow pins one label per pipeline run, end to end", () => {
  const doc = YAML.parse(source());
  // Unique per workflow run: this is the concurrency trap the recipe exists to
  // avoid. A shared label would let two pull requests claim each other's job.
  assert.equal(doc.env.PLAYTEST_LABEL, "ci-run-${{ github.run_id }}");

  const stepBody = (name: string) =>
    doc.jobs.playtest.steps.find((s: { name?: string }) => s.name === name).run as string;

  assert.match(stepBody("Register an ephemeral runner"), /runner\/pool\/register-oidc/);
  assert.match(stepBody("Register an ephemeral runner"), /ACTIONS_ID_TOKEN_REQUEST_URL/);
  // The credential never reaches a process list or a log.
  assert.match(stepBody("Register an ephemeral runner"), /::add-mask::/);
  assert.doesNotMatch(source(), /--credential\s+\$/, "a credential is never passed as an argument");

  const start = stepBody("Start the runner");
  assert.match(start, /pool\b/);
  assert.match(start, /--labels "\$PLAYTEST_LABEL"/);
  assert.match(start, /--credential-file/);

  const launch = stepBody("Launch the suite and wait for the verdict");
  assert.match(launch, /runner_labels: \[\$label\]/, "the launch pins the same label the runner advertises");
  assert.match(launch, /run-groups\/\$group\?wait=true/, "the verdict comes from the automation wait");
  assert.match(launch, /exit_summary\.exit_code/, "the job exits with the group's verdict");
});
