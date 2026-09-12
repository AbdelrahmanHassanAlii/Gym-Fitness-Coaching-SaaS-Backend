import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type CheckResult = {
  name: string;
  command: string;
  exitCode: number;
  output: string;
};

const reportPath = resolve('reports/pre-push-checks.md');

const checks = [
  {
    name: 'Tests (unit / integration)',
    command: 'bun test --parallel=1 --timeout=120000',
    args: ['test', '--parallel=1', '--timeout=120000'],
  },
  {
    name: 'Lint',
    command: 'bun run lint',
    args: ['run', 'lint'],
  },
  {
    name: 'Type check',
    command: 'bun run typecheck',
    args: ['run', 'typecheck'],
  },
];

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

function runCheck(check: (typeof checks)[number]): Promise<CheckResult> {
  return new Promise((resolveCheck) => {
    console.log(`\n> ${check.name}`);
    console.log(`$ ${check.command}`);

    let output = '';

    let child: ReturnType<typeof spawn> | null = null;

    try {
      child = spawn(process.execPath, check.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const text = `Failed to start ${check.command}: ${message}\n`;
      output += text;
      process.stderr.write(text);
      resolveCheck({
        name: check.name,
        command: check.command,
        exitCode: 1,
        output,
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      const text = `Failed to start ${check.command}: ${error.message}\n`;
      output += text;
      process.stderr.write(text);
      resolveCheck({
        name: check.name,
        command: check.command,
        exitCode: 1,
        output,
      });
    });

    child.on('close', (code) => {
      resolveCheck({
        name: check.name,
        command: check.command,
        exitCode: code ?? 1,
        output,
      });
    });
  });
}

function createReport(results: CheckResult[]): string {
  const failedResults = results.filter((result) => result.exitCode !== 0);
  const createdAt = new Date().toISOString();

  const sections = results.map((result) => {
    const status = result.exitCode === 0 ? 'PASSED' : 'FAILED';
    const output = stripAnsi(result.output.trim()) || 'No output.';

    return [
      `## ${result.name}`,
      '',
      `Status: ${status}`,
      `Command: \`${result.command}\``,
      `Exit code: ${result.exitCode}`,
      '',
      '```txt',
      output,
      '```',
    ].join('\n');
  });

  return [
    '# Pre-Push Check Report',
    '',
    `Generated: ${createdAt}`,
    `Result: ${failedResults.length === 0 ? 'PASSED' : 'FAILED'}`,
    '',
    '| Check | Status |',
    '| --- | --- |',
    ...results.map(
      (result) => `| ${result.name} | ${result.exitCode === 0 ? 'PASSED' : 'FAILED'} |`,
    ),
    '',
    ...sections,
    '',
  ].join('\n');
}

const results: CheckResult[] = [];

for (const check of checks) {
  results.push(await runCheck(check));
}

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, createReport(results));

const hasFailures = results.some((result) => result.exitCode !== 0);
const reportMessage = `\nPre-push report written to ${reportPath}\n`;

if (hasFailures) {
  console.error(reportMessage);
  console.error('Push rejected. Fix the reported issues, then push again.');
  process.exit(1);
}

console.log(reportMessage);
console.log('All pre-push checks passed.');
