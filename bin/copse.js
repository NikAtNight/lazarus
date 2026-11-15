#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { add, hydrate, port, run } from '../lib/copse.js';

const USAGE = `Usage:
  copse add <branch> [path] [--base <ref>] [--no-install]
      Create a worktree for <branch> and clone node_modules and .env files
      into it from the main checkout. Default path: ../<repo>-<branch>.

  copse hydrate [--no-install]
      Do the clone step for the existing worktree you are in.

  copse port
      Print this worktree's first port. It owns that port and the next 9.

  copse run -- <command...>
      Run <command> with PORT set to this worktree's port. @port and
      @port+1 through @port+9 in the command are replaced too.
      Example: copse run -- pnpm dev --port @port --strictPort

Ports start at 3000 for the main checkout, 3010 for the first worktree, and so
on. Change the start for a repo with: git config copse.port 5173`;

try {
  const [first, ...rest] = process.argv.slice(2);
  if (first === 'run') {
    const command = rest[0] === '--' ? rest.slice(1) : rest;
    process.exitCode = await run(process.cwd(), command, { log: console.error });
  } else {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        base: { type: 'string' },
        'no-install': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    const [command, branch, path] = positionals;
    const options = { install: !values['no-install'], log: console.log };

    if (values.help) {
      console.log(USAGE);
    } else if (command === 'add' && branch) {
      const dest = add(process.cwd(), branch, { path, base: values.base, ...options });
      console.log(`ready   ${dest}`);
    } else if (command === 'hydrate') {
      hydrate(process.cwd(), options);
    } else if (command === 'port') {
      console.log(port(process.cwd()));
    } else {
      console.error(USAGE);
      process.exitCode = 2;
    }
  }
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message);
  process.exitCode = 1;
}
