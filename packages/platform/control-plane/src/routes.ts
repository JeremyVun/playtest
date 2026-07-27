// The route table. Declarative: method + pattern → handler. Every
// handler receives the request ctx and returns a JSON value or an HttpResult. AuthN
// runs before routing (server.ts); per-route authZ (role guards) lives in the
// handlers where the project is known. Phase 1 mounted the suite-of-record surface;
// Phase 2 runs/dispatch, Phase 3 viewer/review, Phase 4 story drafting and
// findings synthesis, Phase 5 media/retention.
import { Router } from "./router.ts";
import * as projects from "./api/projects.ts";
import * as suites from "./api/suites.ts";
import * as environments from "./api/environments.ts";
// Named import: core also exports a `listPersonas` (packages/core/src/public/suite.ts) —
// this module import keeps the two unambiguous.
import * as personasApi from "./api/personas.ts";
import * as secrets from "./api/secrets.ts";
import * as tokens from "./api/tokens.ts";
import * as runners from "./api/runners.ts";
import * as pool from "./api/pool.ts";
import * as auditApi from "./api/audit.ts";
import * as authRoutes from "./api/auth-routes.ts";
import * as authProviders from "./api/auth-providers.ts";
import * as runs from "./api/runs.ts";
import * as executor from "./api/executor-api.ts";
import * as viewer from "./api/viewer-adapter.ts";
import * as review from "./api/review.ts";
import * as storyDraft from "./api/story-draft.ts";
import * as ruleCards from "./api/rule-cards.ts";
import * as findings from "./api/findings.ts";
import * as consolidation from "./api/consolidation.ts";
import * as ops from "./api/ops.ts";

export function buildRouter() {
  const r = new Router();

  // --- auth (top-level, not under /api/v1) ---
  r.get("/auth/login", authRoutes.login);
  r.get("/auth/callback", authRoutes.callback);
  r.post("/auth/logout", authRoutes.logout);

  const v = "/api/v1";

  // --- identity ---
  r.get(`${v}/me`, projects.me);
  r.get(`${v}/users`, projects.lookupUsers);
  r.get(`${v}/models`, projects.modelCatalog);

  // --- projects & membership ---
  r.get(`${v}/projects`, projects.listProjects);
  r.post(`${v}/projects`, projects.createProject);
  r.get(`${v}/projects/:p`, projects.getProject);
  r.del(`${v}/projects/:p`, projects.deleteProject);
  r.get(`${v}/projects/:p/members`, projects.listMembers);
  r.get(`${v}/projects/:p/health`, projects.health);
  r.put(`${v}/projects/:p/members/:userId`, projects.putMember);
  r.del(`${v}/projects/:p/members/:userId`, projects.deleteMember);
  r.put(`${v}/projects/:p/models`, projects.putModels);
  r.put(`${v}/projects/:p/parallel`, projects.putParallel);
  r.put(`${v}/projects/:p/auto-dedupe`, projects.putAutoDedupe);
  r.put(`${v}/projects/:p/auto-resolve`, projects.putAutoResolve);

  // --- suites & files ---
  r.get(`${v}/projects/:p/suites`, suites.listSuites);
  r.post(`${v}/projects/:p/suites`, suites.createSuite);
  r.get(`${v}/projects/:p/suites/:slug`, suites.getSuiteBySlug);
  r.patch(`${v}/suites/:s`, suites.patchSuite);
  r.del(`${v}/suites/:s`, suites.deleteSuite);
  r.get(`${v}/suites/:s/files/*path`, suites.getFile);
  r.put(`${v}/suites/:s/files/*path`, suites.putFile);
  r.del(`${v}/suites/:s/files/*path`, suites.deleteFile);
  r.post(`${v}/suites/:s/commit`, suites.commit);
  r.post(`${v}/suites/:s/validate`, suites.validate);
  r.post(`${v}/suites/:s/lint`, suites.lint);
  r.get(`${v}/suites/:s/cases`, suites.cases);
  r.get(`${v}/suites/:s/snapshots`, suites.listSnapshots);
  r.get(`${v}/suites/:s/export`, suites.exportSuite);
  r.post(`${v}/suites/:s/import`, suites.importSuite);

  // --- environments, secrets, tokens ---
  r.get(`${v}/projects/:p/environments`, environments.listEnvironments);
  r.post(`${v}/projects/:p/environments`, environments.createEnvironment);
  r.put(`${v}/environments/:e`, environments.updateEnvironment);
  r.del(`${v}/environments/:e`, environments.deleteEnvironment);
  // The app binary an environment ships to whichever runner takes its work.
  r.put(`${v}/environments/:e/app-artifact`, environments.putAppArtifact);
  r.del(`${v}/environments/:e/app-artifact`, environments.deleteAppArtifact);
  r.get(`${v}/projects/:p/personas`, personasApi.listPersonas);
  r.post(`${v}/projects/:p/personas`, personasApi.createPersona);
  r.put(`${v}/personas/:id`, personasApi.updatePersona);
  r.del(`${v}/personas/:id`, personasApi.deletePersona);
  r.get(`${v}/projects/:p/auth-providers`, authProviders.listAuthProviders);
  r.post(`${v}/projects/:p/auth-providers`, authProviders.createAuthProvider);
  r.put(`${v}/auth-providers/:a`, authProviders.updateAuthProvider);
  r.del(`${v}/auth-providers/:a`, authProviders.deleteAuthProvider);
  r.post(`${v}/auth-providers/:a/mint`, authProviders.mintAuthProvider);
  r.get(`${v}/auth-providers/:a/sessions`, authProviders.sessions);
  r.get(`${v}/projects/:p/secrets`, secrets.listSecrets);
  r.post(`${v}/projects/:p/secrets`, secrets.putSecret);
  r.del(`${v}/projects/:p/secrets/:name`, secrets.deleteSecret);
  r.get(`${v}/projects/:p/tokens`, tokens.listTokens);
  r.post(`${v}/projects/:p/tokens`, tokens.createToken);
  r.del(`${v}/tokens/:id`, tokens.deleteToken);

  // --- self-hosted runner registry (identity; labels route, they do not authorize) ---
  r.get(`${v}/projects/:p/runners`, runners.listRunners);
  r.post(`${v}/projects/:p/runners`, runners.createRunner);
  r.del(`${v}/projects/:p/runners/:r`, runners.deleteRunner);

  // --- runs / event feed ---
  r.post(`${v}/projects/:p/run-groups/preview`, runs.previewGroup);
  r.post(`${v}/projects/:p/run-groups`, runs.createGroup);
  r.get(`${v}/projects/:p/run-groups`, runs.listGroups);
  r.get(`${v}/run-groups/:g`, runs.getGroup);
  r.post(`${v}/run-groups/:g/retry`, runs.retryGroup);
  r.post(`${v}/run-groups/:g/cancel`, runs.cancelGroup);
  r.get(`${v}/runs`, runs.listRuns);
  r.get(`${v}/runs/:r`, runs.getRun);
  r.get(`${v}/runs/:r/download`, runs.download);
  r.get(`${v}/runs/:r/clip`, runs.downloadClip);
  r.post(`${v}/runs/:r/clip`, runs.createClip);
  r.get(`${v}/projects/:p/events/feed`, runs.feed);
  r.get(`${v}/projects/:p/dispatches`, runs.dispatchAdmin);
  r.get(`${v}/projects/:p/ops`, ops.projectOps);

  // --- inline story drafting (one stateless, no-durable-write endpoint) ---
  r.post(`${v}/suites/:s/story-draft`, storyDraft.storyDraft);

  // --- rule cards (Level 1; only an approved sentence is ever enforced) ---
  r.get(`${v}/suites/:s/rule-cards`, ruleCards.listCards);
  r.get(`${v}/suites/:s/rule-cards/handout`, ruleCards.handoutRules);
  r.post(`${v}/suites/:s/rule-cards`, ruleCards.addCard);
  r.post(`${v}/suites/:s/rule-cards/propose`, ruleCards.proposeCards);
  r.patch(`${v}/rule-cards/:rc`, ruleCards.editCard);
  r.del(`${v}/rule-cards/:rc`, ruleCards.removeCard);
  r.post(`${v}/rule-cards/:rc/approve`, ruleCards.approveCard);
  r.post(`${v}/rule-cards/:rc/deny`, ruleCards.denyCard);

  // --- findings (findings own cross-run synthesis; no Insight mediates) ---
  r.get(`${v}/projects/:p/findings`, findings.listFindings);
  r.get(`${v}/projects/:p/findings/counts`, findings.findingCounts);
  r.get(`${v}/findings/:f`, findings.getFinding);
  r.post(`${v}/findings/:f/accept`, findings.acceptFinding);
  r.post(`${v}/findings/:f/reject`, findings.rejectFinding);
  r.post(`${v}/findings/:f/resolve`, findings.resolveFinding);
  r.post(`${v}/findings/:f/reopen`, findings.reopenFinding);
  r.post(`${v}/findings/:f/acknowledge`, findings.acknowledgeFinding);
  r.post(`${v}/findings/:f/not-fixed`, findings.suggestionNotFixed);
  r.post(`${v}/findings/:f/merge`, findings.mergeFinding);
  r.post(`${v}/finding-evidence/:e/split`, findings.splitEvidence);
  r.post(`${v}/runs/:r/promote-finding`, findings.promoteRun);
  r.post(`${v}/run-groups/:g/synthesize-findings`, findings.synthesizeGroup);

  // --- consolidation (retrieve-then-verify over the unreviewed findings). A
  //     plan is a proposal: it mutates nothing until a reviewer applies it. ---
  r.get(`${v}/projects/:p/consolidation/preview`, consolidation.previewProjectConsolidation);
  r.post(`${v}/projects/:p/consolidation`, consolidation.createConsolidationPlan);
  r.get(`${v}/projects/:p/consolidation-plans`, consolidation.listConsolidationPlans);
  r.get(`${v}/consolidation-plans/:id`, consolidation.getConsolidationPlan);
  r.post(`${v}/consolidation-plans/:id/apply`, consolidation.applyPlan);
  r.post(`${v}/consolidation-plans/:id/discard`, consolidation.discardPlan);

  // --- review (changed journeys) ---
  r.get(`${v}/projects/:p/candidates`, review.listCandidates);
  r.get(`${v}/candidates/:c`, review.getCandidate);
  r.post(`${v}/candidates/:c/accept`, review.acceptCandidate);
  r.post(`${v}/candidates/:c/reject`, review.rejectCandidate);
  // One-way Playwright spec for a story's accepted baseline: a download, never
  // an execution mode (docs/contracts/interfaces.md#playwright-export).
  r.get(`${v}/suites/:s/playwright-export`, review.exportPlaywright);

  // --- viewer adapter (docs/contracts/interfaces.md#viewer-url-contract;
  //     viewer assets arrive inside the completed @playtest/web build) ---
  // Data routes register before the project-scoped static catchall — the router
  // is first-match-wins.
  r.get(`${v}/projects/:p/view/runs.json`, viewer.runsJson);
  r.get(`${v}/projects/:p/view/changed.json`, viewer.changedJson);
  r.get(`${v}/projects/:p/view/history.json`, viewer.historyJson);
  r.get(`${v}/projects/:p/view/run/*path`, viewer.runEntry);
  r.get(`${v}/projects/:p/view`, viewer.viewIndex);
  r.get(`${v}/projects/:p/view/*path`, viewer.viewStatic);

  // --- runner claim board (runner-credential authenticated; pull-based
  //     placement, so nothing here is ever an inbound call to a runner) ---
  // Joining the pool for one CI job: the GitHub OIDC token is the badge, so this
  // is the one runner route that presents no runner credential (it mints one).
  r.post(`${v}/runner/pool/register-oidc`, pool.registerViaOidc);
  r.get(`${v}/runner/pool/claims`, pool.pollClaims);
  r.post(`${v}/runner/pool/claims/:dispatch`, pool.claimDispatch);
  r.post(`${v}/runner/pool/claims/:dispatch/heartbeat`, pool.heartbeatClaim);

  // --- group executor protocol ---
  r.post(`${v}/runner/exchange`, executor.exchange);
  r.get(`${v}/runner/groups/:g`, executor.groupSpec);
  r.get(`${v}/runner/snapshots/:id/tree`, executor.snapshotTree);
  r.get(`${v}/runner/blobs/:sha256`, executor.blob);
  r.get(`${v}/runner/artifacts/:sha256`, executor.appArtifact);
  r.get(`${v}/runner/baselines/:id/trajectory`, executor.baselineTrajectory);
  r.post(`${v}/runner/sessions/claim`, executor.claim);
  r.post(`${v}/runner/sessions/:claim/fulfill`, executor.fulfill);
  r.get(`${v}/runner/mints/:claim`, executor.mintSpec);
  r.post(`${v}/runner/mints/:claim/complete`, executor.mintComplete);
  r.put(`${v}/runner/runs/:r/bundle`, executor.uploadBundle);
  r.post(`${v}/runner/groups/:g/cases/:run_id/start`, executor.caseStart);
  r.post(`${v}/runner/groups/:g/cases/:run_id/progress`, executor.caseProgress);
  r.post(`${v}/runner/groups/:g/cases/:run_id/report`, executor.caseReport);
  r.post(`${v}/runner/groups/:g/complete`, executor.complete);

  // --- audit ---
  r.get(`${v}/projects/:p/audit`, auditApi.listAudit);

  return r;
}
