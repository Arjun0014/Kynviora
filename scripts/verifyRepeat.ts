/**
 * Run the test suite N times and say whether every run was green.
 *
 * Spec references: `04` Phase 0.3 (one CI gate over the whole graph), `24` (a gate whose red
 * results are not acted on is not a gate), DEC-102, `DEV-096`, trap 208.
 *
 * WHY THIS EXISTS
 * `DEV-096` was a gate that failed about one run in two, on a different file each time, with a
 * transform error rather than an assertion - and the thing that made it expensive was not the
 * failure but what it taught: that a red `npm run verify` is worth re-running rather than
 * reading. One green run cannot tell you a gate is deterministic. Ten can tell you it probably is,
 * and this is the cheapest way to ask.
 *
 * It is deliberately **not** part of `npm run verify`. It costs the suite's duration times N, it
 * answers a question about the gate rather than about the code, and a gate that took twenty
 * minutes would get skipped, which is the failure `24` is about from the other side.
 *
 * WHEN TO RUN IT
 * After anything that changes how modules are resolved or transformed - the Vitest configuration,
 * a tsconfig, a dependency bump that moves Vite, Rolldown or Oxc - and before believing a report
 * that the gate is flaky. Run it on a **loaded** machine if you have one: `DEV-096` did not
 * reproduce on an idle one.
 *
 *   npm run verify:repeat        # five runs
 *   npm run verify:repeat -- 10  # ten
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * Retry, or aggregate. A run is green or it is not, the first red one stops the loop with its
 * output on screen, and the exit code is the answer. Anything that summarised a red run into a
 * ratio would be teaching the same lesson `DEV-096` taught.
 */

import { spawnSync } from 'node:child_process';

const DEFAULT_RUNS = 5;

function runCount(argv: readonly string[]): number {
  const raw = argv[2];
  if (raw === undefined) return DEFAULT_RUNS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`Expected a positive whole number of runs, got ${JSON.stringify(raw)}.`);
    process.exit(2);
  }
  return parsed;
}

function main(): void {
  const runs = runCount(process.argv);
  console.warn(`Running the suite ${runs} times. A single red run ends this and is the answer.`);

  for (let run = 1; run <= runs; run++) {
    const startedAt = Date.now();
    console.warn(`\n--- run ${run} of ${runs} ---`);
    const result = spawnSync('npx', ['vitest', 'run'], { stdio: 'inherit', shell: true });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (result.status !== 0) {
      console.error(
        `\nRun ${run} of ${runs} was not green (exit ${String(result.status)}) after ${seconds}s.` +
          `\nA transform failure naming a tsconfig is DEV-096's shape: read trap 208 before` +
          ` investigating the file it names, and check what else this machine is running.`,
      );
      process.exit(result.status ?? 1);
    }
    console.warn(`run ${run} green in ${seconds}s`);
  }

  console.warn(`\n${runs} of ${runs} runs green.`);
}

main();
