#!/usr/bin/env node
// tools/ux-lab — drive the hosted Playtest console for UX work.
//
//   node tools/ux-lab/lab.mjs serve            boot a seeded lab plane and hold it open
//   node tools/ux-lab/lab.mjs shoot            boot, seed, screenshot every surface
//   node tools/ux-lab/lab.mjs shoot --only runs --theme dark
//   node tools/ux-lab/lab.mjs list             print the surface inventory
//
// The lab never touches the developer's own data root or port 4177: it boots a
// throwaway control plane on :4188 (see plane.mjs) against tools/ux-lab/.data.
import { startPlane } from "./plane.mjs";
import { seed } from "./seed.mjs";
import { SURFACES } from "./surfaces.mjs";
import { capture } from "./capture.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      const next = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
      args[k] = next;
    } else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "shoot";

  if (cmd === "list") {
    for (const s of SURFACES) console.log(`${s.id.padEnd(28)} ${s.title}`);
    console.log(`\n${SURFACES.length} surfaces`);
    return;
  }

  const port = Number(args.port || 4188);
  console.log(`booting lab control plane on :${port}`);
  const plane = await startPlane({ port, log: args.verbose === "true" });
  console.log("seeding:");
  const data = await seed(plane);

  if (cmd === "serve") {
    console.log(`\nlab ready → ${plane.base}/p/${data.projectKey}`);
    console.log(`  empty project   ${plane.base}/p/${data.emptyProjectKey}`);
    console.log(`  suite           ${plane.base}/p/${data.projectKey}/suites/${data.suiteSlug}`);
    console.log(`  runs            ${plane.base}/p/${data.projectKey}/runs`);
    console.log(`  findings        ${plane.base}/p/${data.projectKey}/findings`);
    console.log(`  settings        ${plane.base}/p/${data.projectKey}/settings`);
    console.log("\nCtrl-C to stop.");
    process.on("SIGINT", async () => {
      await plane.stop();
      process.exit(0);
    });
    await new Promise(() => {});
    return;
  }

  if (cmd === "shoot") {
    const report = await capture({
      base: plane.base,
      data,
      only: args.only ? String(args.only).split(",") : null,
      themes: args.theme && args.theme !== "both" ? [args.theme] : ["dark", "light"],
      width: Number(args.width || 1440),
      height: Number(args.height || 900),
      headed: args.headed === "true",
      // A second run at another width writes to out-<tag>/ instead of clobbering.
      tag: args.tag ? String(args.tag) : "",
    });
    await plane.stop();
    console.log(`\n${report.shots} screenshots → ${report.outDir}`);
    if (report.problems.length) {
      console.log(`\n${report.problems.length} runtime problems captured:`);
      for (const p of report.problems) console.log(`  [${p.surface}] ${p.kind}: ${p.text}`);
    } else {
      console.log("\nno console errors, page errors, or failed requests");
    }
    return;
  }

  console.error(`unknown command "${cmd}" (serve | shoot | list)`);
  process.exitCode = 1;
}

main().catch(async (e) => {
  console.error("\nlab failed:", e.stack || e.message);
  process.exit(1);
});
