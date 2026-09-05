# Playtest registration candidate

These files are prepared in the product repo so the infra auto-committer cannot
publish a partially configured stack. Nothing here has been registered or pushed.
Target: `syd1`, `playtest.jeremyvun.com`, existing Authelia one-factor admission;
every admitted person is a Playtest site admin.

After local acceptance and real Spaces/Auth verification:

1. Copy Compose, config, secret-key example and this README into
   `projects/stacks/playtest/`. Complete the non-secret inputs and prepare/seal
   generated keys and owner-supplied Spaces/model credentials without printing
   plaintext. Do not define the infra-injected `REGISTRY_DOMAIN`.
2. Copy `postgres-provision.sql` to
   `projects/stacks/postgres/provision.d/playtest.sql`. Add
   `PLAYTEST_DB_PASSWORD: ${PLAYTEST_DB_PASSWORD}` to that stack's provision
   environment and key template. Mirror Playtest's hex tenant password there.
3. Add an Authelia access-control rule:
   `domain: playtest.jeremyvun.com`, `policy: one_factor`. The existing
   `jeremyvun.com` cookie configuration applies. Do not touch `authelia/auth/`.
   Mirror the generated ingress key into edge-proxy's sealed keys and pass
   `PLAYTEST_PROXY_SECRET: ${PLAYTEST_PROXY_SECRET:?seal Playtest ingress key}`
   to Caddy. The label uses `{env.PLAYTEST_PROXY_SECRET}` so rendered Caddy
   configuration never contains the key itself.
4. Add `playtest` to `hosts/syd1.yaml`. Set DNS
   `playtest.jeremyvun.com` to syd1 using the existing proxied/strict-TLS pattern.
5. Publish the matching `control-plane`, `runner` and `job` images after rollout
   authorization. The job-image one-shot makes Compose pull/check the job image
   before runner readiness; the startup probe additionally verifies its revision
   and host mount. Register the host socket group explicitly.
6. Run infra checks and placeholder-only Compose validation, then commit the
   complete explicit file list, push and deploy through deployctl. Provision
   Postgres first and restart Authelia to apply the admission rule.
7. Verify external TLS/health, anonymous denial, blocked public runner paths,
   authenticated execution, recreation and a completed maintenance backup.

Resource placement remains gated by measured headroom alongside existing syd1
services. The profile budgets 4 GiB control-plane, 1 GiB runner and 2 GiB per
active job, plus shared services. Configure a maintenance backup schedule using
`docs/guidance/hosted-deployment.md`; the shared database dump alone does not
preserve Playtest's object evidence. Schema migrations require compatible-image
rollback or a verified recovery set.
