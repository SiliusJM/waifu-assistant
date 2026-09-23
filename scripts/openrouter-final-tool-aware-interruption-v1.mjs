import { pathToFileURL } from 'node:url';
import { assertSafeReport, runOpenRouterFinalToolAwareInterruption } from './direct-provider-compatibility-matrix-v1.mjs';

export async function main() {
  const report = await runOpenRouterFinalToolAwareInterruption();
  assertSafeReport(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.inferenceRequests > 3 || report.retries !== 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('{"status":"FAIL","reason":"SAFE_OPENROUTER_INTERRUPTION_ERROR","secretExposure":false}\n');
    process.exitCode = 1;
  });
}
