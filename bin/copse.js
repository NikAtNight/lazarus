#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { add, dev, hydrate, list, port, remove, run } from '../lib/copse.js';

const USAGE = `Usage:
  copse add <branch> [path] [--base <ref>] [--no-install]
      Create a worktree for <branch> and clone node_modules and .env files
      into it from the main checkout. Default path: ../<repo>-<branch>.

  copse list
      Show every worktree with its branch, port, and whether its server is up.

  copse rm <branch|path> [--force]
      Stop the worktree's copse servers, remove it, and delete its branch if
      merged. --force also discards uncommitted changes.

  copse dev
      Run the "dev" command from copse.json on this worktree's port.

  copse run -- <command...>
      Run <command> with PORT set to this worktree's port. @port and
      @port+1 through @port+9 in the command are replaced too.
      Example: copse run -- pnpm dev --port @port --strictPort

  copse port
      Print this worktree's first port. It owns that port and the next 9.

  copse hydrate [--no-install]
      Do the clone step for the existing worktree you are in.

Ports start at 3000 for the main checkout, 3010 for the first worktree, and so
on. Settings live in copse.json in the main checkout:
  { "port": 5173, "dev": "pnpm dev --port @port", "clone": ["data"] }`;

function printList(trees) {
  const rows = trees.map((tree) => [
    tree.current ? '*' : ' ',
    tree.branch ?? '(detached)',
    tree.port === null ? '-' : String(tree.port),
    tree.up ? 'up' : '-',
    tree.path,
  ]);
  const table = [[' ', 'BRANCH', 'PORT', 'SERVER', 'PATH'], ...rows];
  const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)));
  for (const row of table) {
    console.log(row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd());
  }
}

try {
  const [first, ...rest] = process.argv.slice(2);
  const cwd = process.cwd();
  if (first === 'run') {
    const command = rest[0] === '--' ? rest.slice(1) : rest;
    process.exitCode = await run(cwd, command, { log: console.error });
  } else {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        base: { type: 'string' },
        'no-install': { type: 'boolean' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    const [command, name, path] = positionals;
    const options = { install: !values['no-install'], log: console.log };

    if (values.help) {
      console.log(USAGE);
    } else if (command === 'add' && name) {
      const dest = add(cwd, name, { path, base: values.base, ...options });
      console.log(`ready   ${dest}`);
    } else if (command === 'list') {
      printList(await list(cwd));
    } else if (command === 'rm' && name) {
      await remove(cwd, name, { force: values.force, log: console.log });
    } else if (command === 'dev') {
      process.exitCode = await dev(cwd, { log: console.error });
    } else if (command === 'hydrate') {
      hydrate(cwd, options);
    } else if (command === 'port') {
      console.log(port(cwd));
    } else {
      console.error(USAGE);
      process.exitCode = 2;
    }
  }
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message);
  process.exitCode = 1;
}
