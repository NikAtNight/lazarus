import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
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
import { add, fillPorts, hydrate, installCommand, list, port, readConfig, slot } from '../lib/copse.js';

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

// Ask the OS for a free port, then set the repo's base so slot 1 lands on it.
async function useFreePort(repo, extra = {}) {
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise((done) => probe.once('listening', done));
  const free = probe.address().port;
  await new Promise((done) => probe.close(done));
  put(repo, 'copse.json', JSON.stringify({ port: free - 10, ...extra }));
  return free;
}

async function waitFor(condition, what) {
  for (const deadline = Date.now() + 10_000; !(await condition()); ) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

const copse = (cwd, ...args) => promisify(execFile)('node', [BIN, ...args], { cwd });

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
  put(repo, 'copse.json', '{ "port": 5173 }');
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
  const expected = await useFreePort(repo);
  assert.equal(port(dest), expected);
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

test('copse.json adds paths to clone and rejects settings it does not know', (t) => {
  const { repo } = makeRepo(t);
  put(repo, 'copse.json', '{ "clone": ["dist", "missing"] }');

  const dest = add(repo, 'with-data', { install: false });
  assert.equal(readFileSync(join(dest, 'dist/bundle.js'), 'utf8'), 'built');
  appendFileSync(join(dest, 'dist/bundle.js'), ' changed');
  assert.equal(readFileSync(join(repo, 'dist/bundle.js'), 'utf8'), 'built');

  for (const bad of ['{ "prot": 1 }', '{ "port": "3000" }', '{ "clone": ["../x"] }', '{ nope']) {
    put(repo, 'copse.json', bad);
    assert.throws(() => readConfig(dest), /copse\.json/, bad);
  }
});

test('copse dev runs the configured command through a shell on the worktree port', async (t) => {
  const { root, repo } = makeRepo(t);
  const dest = add(repo, 'dev', { install: false });
  await assert.rejects(copse(dest, 'dev'), /No dev command/);

  const script = join(root, 'show.js');
  writeFileSync(script, 'console.log(process.env.PORT, process.env.API, process.argv[2])');
  const expected = await useFreePort(repo, { dev: `API=@port+1 node ${script} @port && echo done` });

  const { stdout } = await copse(dest, 'dev');
  assert.equal(stdout.trim(), `${expected} ${expected + 1} ${expected}\ndone`);
});

test('list shows each worktree with its port and whether a server is up', async (t) => {
  const { root, repo } = makeRepo(t);
  const first = add(repo, 'one', { install: false });
  const plain = join(root, 'plain');
  git(repo, 'worktree', 'add', '-q', '-b', 'plain', plain);
  const expected = await useFreePort(repo);
  const server = createServer().listen(expected, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((done) => server.once('listening', done));

  assert.deepEqual(await list(first), [
    { path: repo, branch: 'main', port: expected - 10, up: false, current: false },
    { path: first, branch: 'one', port: expected, up: true, current: true },
    { path: plain, branch: 'plain', port: null, up: false, current: false },
  ]);
  const { stdout } = await copse(repo, 'list');
  assert.match(stdout, new RegExp(`\\* +main +${expected - 10} +- +${repo}\\n +one +${expected} +up `));
});

test('rm stops the worktree server, removes the worktree, and deletes a merged branch', async (t) => {
  const { repo } = makeRepo(t);
  const dest = add(repo, 'done', { install: false });
  const expected = await useFreePort(repo);
  const serve = 'require("node:http").createServer((_, res) => res.end("hi")).listen(process.env.PORT, "127.0.0.1")';
  const server = spawn('node', [BIN, 'run', '--', 'node', '-e', serve], { cwd: dest, stdio: 'ignore' });
  t.after(() => server.kill());
  const exited = new Promise((done) => server.once('exit', done));
  const isUp = async () => (await list(repo)).find((tree) => tree.branch === 'done')?.up;
  await waitFor(isUp, 'the server to start');

  const { stdout } = await copse(repo, 'rm', 'done');

  await exited;
  assert.match(stdout, /stop +process \d+\nremoved .*app-done\ndeleted branch done/);
  assert.equal(existsSync(dest), false);
  assert.equal(git(repo, 'branch', '--list', 'done'), '');
  const probe = createServer().listen(expected, '127.0.0.1');
  await new Promise((done, fail) => probe.once('listening', done).once('error', fail));
  probe.close();
});

test('rm keeps unmerged work: a dirty worktree needs --force and an unmerged branch stays', async (t) => {
  const { repo } = makeRepo(t);
  const dest = add(repo, 'wip', { install: false });
  put(dest, 'feature.txt', 'new work');
  git(dest, 'add', '.');
  git(dest, 'commit', '-q', '-m', 'work');
  put(dest, 'package.json', '{"name":"edited"}');

  await assert.rejects(copse(repo, 'rm', 'wip'), /modified or untracked files/);
  assert.ok(existsSync(dest));
  await assert.rejects(copse(repo, 'rm', 'main'), /main checkout/);
  await assert.rejects(copse(repo, 'rm', 'nope'), /No worktree for "nope"/);

  const { stdout } = await copse(dest, 'rm', 'wip', '--force');
  assert.match(stdout, /kept +branch wip \(not merged\)/);
  assert.equal(existsSync(dest), false);
  assert.equal(git(repo, 'branch', '--list', 'wip').trim(), 'wip');
});
