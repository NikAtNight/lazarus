import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { add, fillPorts, hydrate, installCommand, port, slot } from '../lib/copse.js';

const BIN = fileURLToPath(new URL('../bin/copse.js', import.meta.url));

function git(cwd, ...args) {
  const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
  return execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8' }).trim();
}

function put(root, path, content = '') {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

// A repo at <tmp>/app with two commits. The first has no packages/a. The working
// copy then gets the ignored files a real project has: dependencies, env, build output.
function makeRepo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'copse-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, 'package.json', '{"name":"app"}');
  put(repo, 'package-lock.json', '{"lockfileVersion":3}');
  put(repo, '.gitignore', 'node_modules\n.env*\ndist\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  const first = git(repo, 'rev-parse', 'HEAD');
  put(repo, 'packages/a/package.json', '{"name":"a"}');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'second');

  put(repo, 'node_modules/pkg/cli.js', 'original');
  chmodSync(join(repo, 'node_modules/pkg/cli.js'), 0o755);
  mkdirSync(join(repo, 'node_modules/.bin'));
  symlinkSync('../pkg/cli.js', join(repo, 'node_modules/.bin/pkg'));
  put(repo, 'packages/a/node_modules/dep/index.js', 'nested');
  put(repo, "node_modules/.vite/deps/dep.js", `import "${repo}/node_modules/pkg/cli.js"`);
  put(repo, 'packages/a/node_modules/.bin/tool', `export NODE_PATH="${repo}/node_modules/.pnpm"\n`);
  put(repo, '.env', 'SECRET=1');
  put(repo, 'packages/a/.env.local', 'LOCAL=1');
  put(repo, 'dist/bundle.js', 'built');
  return { root, repo, first };
}

test('add creates a worktree with its own runnable copy of dependencies and env files', (t) => {
  const { root, repo } = makeRepo(t);

  const dest = add(repo, 'feature', { install: false });

  assert.equal(dest, join(root, 'app-feature'));
  assert.equal(git(dest, 'branch', '--show-current'), 'feature');
  assert.equal(readFileSync(join(dest, 'node_modules/pkg/cli.js'), 'utf8'), 'original');
  assert.equal(statSync(join(dest, 'node_modules/pkg/cli.js')).mode & 0o777, 0o755);
  assert.ok(lstatSync(join(dest, 'node_modules/.bin/pkg')).isSymbolicLink());
  assert.equal(readFileSync(join(dest, 'packages/a/node_modules/dep/index.js'), 'utf8'), 'nested');
  assert.equal(
    readFileSync(join(dest, 'packages/a/node_modules/.bin/tool'), 'utf8'),
    `export NODE_PATH="${dest}/node_modules/.pnpm"\n`,
    'pnpm bin shims point at the worktree',
  );
  assert.equal(existsSync(join(dest, "node_modules/.vite")), false, "tool caches stay behind");
  assert.equal(readlinkSync(join(dest, 'node_modules/.bin/pkg')), '../pkg/cli.js');
  assert.equal(readFileSync(join(dest, '.env'), 'utf8'), 'SECRET=1');
  assert.equal(readFileSync(join(dest, 'packages/a/.env.local'), 'utf8'), 'LOCAL=1');
  assert.equal(existsSync(join(dest, 'dist')), false, 'build output stays behind');
  assert.equal(git(dest, 'status', '--porcelain'), '', 'cloned files stay ignored');

  appendFileSync(join(dest, 'node_modules/pkg/cli.js'), ' changed');
  assert.equal(readFileSync(join(repo, 'node_modules/pkg/cli.js'), 'utf8'), 'original');
});

test('the copse command names the folder safely for a branch with a slash', (t) => {
  const { root, repo } = makeRepo(t);

  const output = execFileSync('node', [BIN, 'add', 'feat/login', '--no-install'], {
    cwd: repo,
    encoding: 'utf8',
  });

  assert.match(output, /clone {3}node_modules/);
  assert.ok(output.includes(`ready   ${join(root, 'app-feat-login')}`));
  assert.ok(existsSync(join(root, 'app-feat-login/node_modules/pkg/cli.js')));
});

test('add checks out an existing branch and rejects --base for it', (t) => {
  const { repo, first } = makeRepo(t);
  git(repo, 'branch', 'existing', first);

  assert.throws(() => add(repo, 'existing', { base: 'main', install: false }), /already exists/);
  const dest = add(repo, 'existing', { install: false });

  assert.equal(git(dest, 'rev-parse', 'HEAD'), first);
});

test('add skips a nested node_modules when the branch has no folder for it', (t) => {
  const { repo, first } = makeRepo(t);

  const dest = add(repo, 'old', { base: first, install: false });

  assert.equal(existsSync(join(dest, 'packages')), false);
  assert.ok(existsSync(join(dest, 'node_modules/pkg/cli.js')));
});

test('hydrate fills a worktree made by plain git and keeps files already there', (t) => {
  const { root, repo } = makeRepo(t);
  const dest = join(root, 'other');
  git(repo, 'worktree', 'add', '-q', '-b', 'other', dest);
  put(dest, '.env', 'MINE=1');

  hydrate(dest, { install: false });

  assert.equal(readFileSync(join(dest, '.env'), 'utf8'), 'MINE=1');
  assert.ok(existsSync(join(dest, 'node_modules/pkg/cli.js')));
  assert.throws(() => hydrate(repo, { install: false }), /main checkout/);
});

test('an install is needed only when the lockfile differs or dependencies are missing', (t) => {
  const { repo } = makeRepo(t);
  const dest = add(repo, 'deps', { install: false });
  const npmInstall = ['npm', 'install', '--prefer-offline', '--no-audit', '--no-fund'];

  assert.equal(installCommand(repo, dest), null);

  put(dest, 'package-lock.json', '{"lockfileVersion":3,"changed":true}');
  assert.deepEqual(installCommand(repo, dest), npmInstall);

  put(dest, 'package-lock.json', '{"lockfileVersion":3}');
  rmSync(join(dest, 'node_modules'), { recursive: true });
  assert.deepEqual(installCommand(repo, dest), npmInstall);
});

test('worktrees made at the same moment get different slots, and a removed one frees its slot', async (t) => {
  const { root, repo } = makeRepo(t);
  const run = promisify(execFile);

  await Promise.all(
    [1, 2, 3, 4, 5].map((n) => run('node', [BIN, 'add', `agent-${n}`, '--no-install'], { cwd: repo })),
  );
  const slots = [1, 2, 3, 4, 5].map((n) => slot(join(root, `app-agent-${n}`)));

  assert.deepEqual([...slots].sort(), [1, 2, 3, 4, 5]);
  assert.equal(slot(repo), 0);
  const freed = slots[2];
  git(repo, 'worktree', 'remove', '--force', join(root, 'app-agent-3'));
  assert.equal(slot(add(repo, 'agent-6', { install: false })), freed);
  assert.equal(slot(join(root, 'app-agent-1')), slots[0], 'a slot never changes');
});

test('ports come in blocks of ten from a base the repo can set', (t) => {
  const { repo } = makeRepo(t);
  const first = add(repo, 'one', { install: false });
  const second = add(repo, 'two', { install: false });

  assert.deepEqual([port(repo), port(first), port(second)], [3000, 3010, 3020]);
  git(repo, 'config', 'copse.port', '5173');
  assert.deepEqual([port(repo), port(first), port(second)], [5173, 5183, 5193]);
  assert.deepEqual(fillPorts(['--port', '@port', 'API=@port+1', '@portal'], 5183), [
    '--port',
    '5183',
    'API=5184',
    '@portal',
  ]);
});

test('copse run passes the port to the command and refuses a port already in use', async (t) => {
  const { repo } = makeRepo(t);
  const dest = add(repo, 'server', { install: false });
  // Ask the OS for a free port, then set the base so this worktree (slot 1) lands on it.
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise((done) => probe.once('listening', done));
  const free = probe.address().port;
  await new Promise((done) => probe.close(done));
  git(repo, 'config', 'copse.port', String(free - 10));
  const expected = port(dest);
  assert.equal(expected, free);
  const script = 'console.log(process.env.PORT, process.env.COPSE_SLOT, process.argv[1])';

  const output = execFileSync('node', [BIN, 'run', '--', 'node', '-e', script, '@port+2'], {
    cwd: dest,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(output.trim(), `${expected} 1 ${expected + 2}`);

  const busy = createServer().listen(expected, '127.0.0.1');
  t.after(() => busy.close());
  await new Promise((done) => busy.once('listening', done));
  const attempt = (...args) =>
    promisify(execFile)('node', [BIN, 'run', '--', 'node', '-e', '1', ...args], { cwd: dest }).then(
      () => null,
      (error) => error,
    );
  const refused = await attempt();
  assert.equal(refused?.code, 1);
  assert.match(refused.stderr, new RegExp(`Port ${expected} already has a server`));
  assert.equal(await attempt('@port+1'), null, 'a command naming only @port+N is not checked');
  assert.equal((await attempt('@port', '@port+1'))?.code, 1, 'a command naming @port is checked');
});

test('the placeholder survives a zsh or bash command line that redirects output', (t) => {
  const { root, repo } = makeRepo(t);
  const dest = add(repo, 'shell', { install: false });
  const script = join(root, 'argv.js');
  writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const out = join(root, 'out.txt');

  for (const shell of ['/bin/zsh', '/bin/bash'].filter(existsSync)) {
    execFileSync(shell, ['-c', `node ${BIN} run -- node ${script} --port @port > ${out} 2>/dev/null`], {
      cwd: dest,
    });
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['--port', String(port(dest))], shell);
  }
});
