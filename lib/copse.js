import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';

// Lockfile, package manager, install arguments. First match in the worktree wins.
const INSTALLERS = [
  ['pnpm-lock.yaml', 'pnpm', ['install', '--prefer-offline']],
  ['yarn.lock', 'yarn', ['install']],
  ['bun.lock', 'bun', ['install']],
  ['bun.lockb', 'bun', ['install']],
  ['package-lock.json', 'npm', ['install', '--prefer-offline', '--no-audit', '--no-fund']],
];

// Each worktree owns PORTS_PER_SLOT ports starting at base + slot * PORTS_PER_SLOT.
const DEFAULT_PORT_BASE = 3000;
const PORTS_PER_SLOT = 10;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// git can fail reading a worktree that another process is still creating
// ("failed to read .git/worktrees/x/commondir"). A moment later the read succeeds.
function git(cwd, ...args) {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trimEnd();
    } catch (error) {
      if (attempt === 5 || !/failed to read .*commondir/.test(error.stderr ?? '')) throw error;
      sleep(50);
    }
  }
}

// The .git folder every worktree of the repo shares.
function commonDir(cwd) {
  return git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
}

// The main checkout is the folder that holds the shared .git. Found this way rather than
// with `git worktree list`, which fails if it reads a worktree another process is adding.
function mainWorktree(cwd) {
  const shared = commonDir(cwd);
  if (basename(shared) !== '.git') {
    throw new Error(`${shared} is not inside a checkout, so there is no main checkout to clone from.`);
  }
  return dirname(shared);
}

// macOS can clone a whole folder in one clonefileat(2) call. Node has no binding for it,
// and Perl ships with every Mac. Syscall 462 is clonefileat; -2 is AT_FDCWD.
function cloneWholeTree(source, target) {
  if (process.platform !== 'darwin') return false;
  const result = spawnSync(
    '/usr/bin/perl',
    ['-e', 'exit(syscall(462, -2, $ARGV[0], -2, $ARGV[1], 0) == 0 ? 0 : 1)', source, target],
    { stdio: 'ignore' },
  );
  return result.status === 0;
}

// Copy-on-write copy of a file or folder. Falls back to per-file cp, which still clones
// on APFS, Btrfs, and XFS, and does a full copy elsewhere.
function cloneTree(source, target) {
  if (cloneWholeTree(source, target)) return;
  const args = process.platform === 'darwin' ? ['-cR'] : ['-R', '--reflink=auto'];
  execFileSync('cp', [...args, source, target], { stdio: ['ignore', 'ignore', 'pipe'] });
}

// Ignored, untracked paths in the source checkout that a worktree needs to run:
// every node_modules folder and every .env file. Paths are relative to the root.
function sharedPaths(source) {
  return git(source, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z')
    .split('\0')
    .filter((entry) =>
      entry.endsWith('/')
        ? basename(entry) === 'node_modules'
        : /^\.env(\..+)?$/.test(basename(entry)),
    )
    .map((entry) => entry.replace(/\/$/, ''));
}

// pnpm's .bin shims are scripts with the checkout's absolute path in NODE_PATH.
// Point the cloned ones at the worktree. npm's .bin entries are symlinks; skip them.
function retargetBinShims(nodeModules, source, dest) {
  const binDirs = execFileSync('find', [nodeModules, '-type', 'd', '-name', '.bin'], {
    encoding: 'utf8',
  }).split('\n').filter(Boolean);
  let count = 0;
  for (const dir of binDirs) {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (!lstatSync(file).isFile()) continue;
      const text = readFileSync(file, 'utf8');
      if (!text.includes(`${source}/`)) continue;
      writeFileSync(file, text.replaceAll(`${source}/`, `${dest}/`));
      count++;
    }
  }
  return count;
}

// Run `fn` while holding a lock directory in the shared git dir, so copse commands
// running at the same moment take turns.
function withRepoLock(shared, fn) {
  const lock = join(shared, 'copse.lock');
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${lock}. Delete it if no copse command is running.`);
      }
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

// The worktree's slot number. The main checkout is slot 0. A linked worktree gets the
// lowest free number the first time it asks, kept in its own git dir, so git frees it
// when the worktree is removed.
export function slot(cwd) {
  const gitDir = git(cwd, 'rev-parse', '--absolute-git-dir');
  const shared = commonDir(cwd);
  if (gitDir === shared) return 0;
  const file = join(gitDir, 'copse-slot');
  const read = (path) => Number.parseInt(readFileSync(path, 'utf8'), 10);
  return withRepoLock(shared, () => {
    if (existsSync(file)) return read(file);
    const worktrees = join(shared, 'worktrees');
    const taken = new Set(
      readdirSync(worktrees)
        .map((name) => join(worktrees, name, 'copse-slot'))
        .filter(existsSync)
        .map(read),
    );
    let next = 1;
    while (taken.has(next)) next++;
    writeFileSync(file, `${next}\n`);
    return next;
  });
}

// The first port this worktree owns. Set the base for a repo with `git config copse.port 5173`.
export function port(cwd) {
  let base = DEFAULT_PORT_BASE;
  try {
    base = Number.parseInt(git(cwd, 'config', '--get', 'copse.port'), 10);
  } catch {
    // Not set; keep the default.
  }
  if (!Number.isInteger(base) || base < 1) throw new Error('git config copse.port must be a port number.');
  return base + slot(cwd) * PORTS_PER_SLOT;
}

// @port, not a {port} style placeholder: zsh treats {name} before a > redirection as a
// request for a new file descriptor, and drops the word.
const PLACEHOLDER = /@port(?:\+(\d))?(?![\w+])/g;

// Replace @port and @port+N in each argument.
export function fillPorts(args, first) {
  return args.map((arg) =>
    arg.replace(PLACEHOLDER, (_, offset) => String(first + Number(offset ?? 0))),
  );
}

// Whether the command may listen on the first port: it names @port, or no placeholder
// and relies on PORT. A @port+N can be a port it only connects to, so it isn't checked.
function mayListenOnFirst(args) {
  const offsets = args.flatMap((arg) => [...arg.matchAll(PLACEHOLDER)].map((m) => m[1]));
  return offsets.length === 0 || offsets.includes(undefined);
}

function isListening(portNumber) {
  const probe = (host) =>
    new Promise((done) => {
      const socket = connect({ port: portNumber, host, timeout: 300 });
      const finish = (open) => {
        socket.destroy();
        done(open);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then(([v4, v6]) => v4 || v6);
}

// Run a command with this worktree's port in PORT and in any @port placeholders.
// Fails before starting when something already listens on the first port and the
// command may listen there, instead of letting the server drift to whatever port is
// free. Resolves with the command's exit code.
export async function run(cwd, command, { log = () => {} } = {}) {
  if (command.length === 0) throw new Error('Give a command to run, for example: copse run -- pnpm dev');
  const first = port(cwd);
  if (mayListenOnFirst(command) && (await isListening(first))) {
    throw new Error(`Port ${first} already has a server. Is this worktree's server already running?`);
  }
  const [program, ...args] = fillPorts(command, first);
  log(`port    ${first} (slot ${slot(cwd)})`);
  const child = spawn(program, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(first), COPSE_PORT: String(first), COPSE_SLOT: String(slot(cwd)) },
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

// The install command the worktree needs, or null when the cloned node_modules
// already matches its lockfile.
export function installCommand(source, dest) {
  const installer = INSTALLERS.find(([lockfile]) => existsSync(join(dest, lockfile)));
  if (!installer) return null;
  const [lockfile, manager, args] = installer;
  const sourceLock = join(source, lockfile);
  const upToDate =
    existsSync(join(dest, 'node_modules')) &&
    existsSync(sourceLock) &&
    readFileSync(sourceLock).equals(readFileSync(join(dest, lockfile)));
  return upToDate ? null : [manager, ...args];
}

// Fill the worktree containing `cwd` with clones of the main checkout's
// node_modules and .env files, then install if its lockfile differs.
export function hydrate(cwd, { install = true, log = () => {} } = {}) {
  const source = mainWorktree(cwd);
  const dest = git(cwd, 'rev-parse', '--show-toplevel');
  if (source === dest) {
    throw new Error('This is the main checkout. Run hydrate inside a linked worktree.');
  }

  for (const path of sharedPaths(source)) {
    const target = join(dest, path);
    if (existsSync(target)) {
      log(`skip    ${path} (already there)`);
    } else if (!existsSync(dirname(target))) {
      log(`skip    ${path} (this branch has no ${dirname(path)})`);
    } else {
      const started = Date.now();
      cloneTree(join(source, path), target);
      let shims = 0;
      if (lstatSync(target).isDirectory()) {
        // Tool caches bake in the main checkout's absolute paths. They rebuild on first use.
        for (const cache of ['.vite', '.cache']) {
          rmSync(join(target, cache), { recursive: true, force: true });
        }
        shims = retargetBinShims(target, source, dest);
      }
      log(`clone   ${path} (${Date.now() - started}ms${shims ? `, ${shims} bin shims` : ''})`);
    }
  }

  log(`port    ${port(dest)} (slot ${slot(dest)})`);

  if (!install) return;
  const command = installCommand(source, dest);
  if (!command) {
    log('install not needed');
    return;
  }
  log(`install ${command.join(' ')}`);
  const [manager, ...args] = command;
  const { status, error } = spawnSync(manager, args, { cwd: dest, stdio: 'inherit' });
  if (error) throw error;
  if (status !== 0) throw new Error(`${manager} install failed in ${dest}`);
}

// Create a worktree for `branch` and hydrate it. Returns the worktree path.
export function add(cwd, branch, { path, base, ...options } = {}) {
  const main = mainWorktree(cwd);
  const dest = path
    ? resolve(cwd, path)
    : join(dirname(main), `${basename(main)}-${branch.replaceAll('/', '-')}`);
  // One add at a time: git can fail reading a worktree another add is still creating.
  withRepoLock(commonDir(cwd), () => {
    const hasRef = (pattern) => git(cwd, 'for-each-ref', pattern) !== '';
    const isLocal = hasRef(`refs/heads/${branch}`);
    if (isLocal && base) {
      throw new Error(`Branch ${branch} already exists, so --base does not apply.`);
    }
    const checkOut = isLocal || (!base && hasRef(`refs/remotes/*/${branch}`));
    git(cwd, 'worktree', 'add', ...(checkOut ? [dest, branch] : ['-b', branch, dest, base ?? 'HEAD']));
  });
  hydrate(dest, options);
  return dest;
}
