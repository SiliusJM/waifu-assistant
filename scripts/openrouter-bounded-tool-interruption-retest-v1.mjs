import { pathToFileURL } from 'node:url';
import { assertSafeReport, runOpenRouterToolInterruptionRetest } from './direct-provider-compatibility-matrix-v1.mjs';

export async function main() {
  const resumeInterruptionOnly = process.argv.includes('--resume-interruption-after-tool');
  const report = await runOpenRouterToolInterruptionRetest({
    ...(resumeInterruptionOnly ? { priorInferenceRequests: 3, resumeInterruptionOnly: true } : {}),
  });
  assertSafeReport(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.inferenceCalls > 5 || report.retries !== 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('{"status":"FAIL","reason":"SAFE_OPENROUTER_RETEST_ERROR","secretExposure":false}\n');
    process.exitCode = 1;
  });
}
