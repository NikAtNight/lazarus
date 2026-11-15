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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

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

// macOS can clone a file or a whole folder in one clonefileat(2) call. Node has no
// binding for it, and Perl ships with every Mac. Syscall 462 is clonefileat; -2 is AT_FDCWD.
function clonefile(source, target) {
  const script = 'exit(syscall(462, -2, $ARGV[0], -2, $ARGV[1], 0) == 0 ? 0 : 1)';
  return spawnSync('/usr/bin/perl', ['-e', script, source, target], { stdio: 'ignore' }).status === 0;
}

// Whether the disk can clone files from the main checkout into the worktree. It can't on
// ext4, or when the two sit on different volumes. Tried on one small file.
function canCloneBetween(source, dest) {
  const from = join(source, '.git', 'HEAD');
  const to = join(dest, `.copse-probe-${process.pid}`);
  const cloned =
    process.platform === 'darwin'
      ? clonefile(from, to)
      : spawnSync('cp', ['--reflink=always', from, to], { stdio: 'ignore' }).status === 0;
  rmSync(to, { force: true });
  return cloned;
}

// How a worktree gets a node_modules folder:
//   clone     copy-on-write, when the disk supports it
//   install   skip the copy and let pnpm or bun install, since both link files from
//             their own store and that costs less disk than a full copy
//   hardlink  share every file with the main checkout by hard link (copse.json opt-in)
//   copy      a full copy
export function dependencyMode({ cloneable, manager, install, hardlink }) {
  if (cloneable) return 'clone';
  if (install && (manager === 'pnpm' || manager === 'bun')) return 'install';
  return hardlink ? 'hardlink' : 'copy';
}

function copyTree(source, target, mode) {
  if (mode === 'clone' && process.platform === 'darwin' && clonefile(source, target)) return;
  const args = {
    clone: process.platform === 'darwin' ? ['-cR'] : ['-R', '--reflink=auto'],
    // -P: with -l, GNU cp would follow symlinks and link their targets instead.
    hardlink: ['-RPl'],
    copy: ['-R'],
  }[mode];
  execFileSync('cp', [...args, source, target], { stdio: ['ignore', 'ignore', 'pipe'] });
}

// The repo's settings, from copse.json in the main checkout. One file for every
// worktree, so they all agree on the port base, and edits apply without a commit.
//   port:  first port of the main checkout's block (default 3000)
//   dev:   shell command that `copse dev` runs, with @port placeholders
//   clone: extra ignored paths to clone into each worktree, such as a data folder
//   hardlink: on a disk that can't clone, hard-link node_modules instead of copying it
export function readConfig(cwd) {
  const file = join(mainWorktree(cwd), 'copse.json');
  const config = { port: DEFAULT_PORT_BASE, dev: null, clone: [], hardlink: false };
  if (!existsSync(file)) return config;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  const checks = {
    port: (value) => Number.isInteger(value) && value > 0 && value < 65536,
    dev: (value) => typeof value === 'string' && value.trim() !== '',
    clone: (value) =>
      Array.isArray(value) &&
      value.every((path) => typeof path === 'string' && path !== '' && !isAbsolute(path) && !path.split('/').includes('..')),
    hardlink: (value) => typeof value === 'boolean',
  };
  for (const [key, value] of Object.entries(parsed)) {
    if (!checks[key]) throw new Error(`${file} has an unknown key "${key}". Known keys: port, dev, clone, hardlink.`);
    if (!checks[key](value)) throw new Error(`${file} has an invalid "${key}".`);
    config[key] = value;
  }
  return config;
}

// Ignored, untracked paths in the source checkout that a worktree needs to run:
// every node_modules folder, every .env file, and the config's extra paths.
// Paths are relative to the root.
function sharedPaths(source, extra) {
  const found = git(source, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z')
    .split('\0')
    .filter((entry) =>
      entry.endsWith('/')
        ? basename(entry) === 'node_modules'
        : /^\.env(\..+)?$/.test(basename(entry)),
    )
    .map((entry) => entry.replace(/\/$/, ''));
  const wanted = extra.map((path) => path.replace(/\/+$/, '')).filter((path) => existsSync(join(source, path)));
  return [...new Set([...found, ...wanted])];
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
      // Replace the file rather than write into it: it may be a hard link to main's copy.
      const { mode } = lstatSync(file);
      rmSync(file);
      writeFileSync(file, text.replaceAll(`${source}/`, `${dest}/`), { mode });
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

// The checkout's own git dir: .git for the main checkout, .git/worktrees/<name> otherwise.
function ownGitDir(cwd) {
  return git(cwd, 'rev-parse', '--absolute-git-dir');
}

const readSlot = (file) => Number.parseInt(readFileSync(file, 'utf8'), 10);

// The slot a checkout already has, or null. Never assigns one.
function savedSlot(cwd) {
  const gitDir = ownGitDir(cwd);
  if (gitDir === commonDir(cwd)) return 0;
  const file = join(gitDir, 'copse-slot');
  return existsSync(file) ? readSlot(file) : null;
}

// The worktree's slot number. The main checkout is slot 0. A linked worktree gets the
// lowest free number the first time it asks, kept in its own git dir, so git frees it
// when the worktree is removed.
export function slot(cwd) {
  const gitDir = ownGitDir(cwd);
  const shared = commonDir(cwd);
  if (gitDir === shared) return 0;
  const file = join(gitDir, 'copse-slot');
  return withRepoLock(shared, () => {
    if (existsSync(file)) return readSlot(file);
    const worktrees = join(shared, 'worktrees');
    const taken = new Set(
      readdirSync(worktrees)
        .map((name) => join(worktrees, name, 'copse-slot'))
        .filter(existsSync)
        .map(readSlot),
    );
    let next = 1;
    while (taken.has(next)) next++;
    writeFileSync(file, `${next}\n`);
    return next;
  });
}

// The first port this worktree owns. Set the base for a repo with "port" in copse.json.
export function port(cwd) {
  return readConfig(cwd).port + slot(cwd) * PORTS_PER_SLOT;
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

// Where a checkout records the `copse run` processes started in it, one file per pid.
function runDir(cwd) {
  return join(ownGitDir(cwd), 'copse-run');
}

// Run a command with this worktree's port in PORT and in any @port placeholders.
// Fails before starting when something already listens on the first port and the
// command may listen there, instead of letting the server drift to whatever port is
// free. With `shell`, the command is one string for the shell. Resolves with the
// command's exit code.
export async function run(cwd, command, { shell = false, log = () => {} } = {}) {
  if (command.length === 0) throw new Error('Give a command to run, for example: copse run -- pnpm dev');
  const first = port(cwd);
  if (mayListenOnFirst(command) && (await isListening(first))) {
    throw new Error(`Port ${first} already has a server. Is this worktree's server already running?`);
  }
  const [program, ...args] = fillPorts(command, first);
  log(`port    ${first} (slot ${slot(cwd)})`);
  const child = spawn(program, args, {
    cwd,
    shell,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(first), COPSE_PORT: String(first), COPSE_SLOT: String(slot(cwd)) },
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }
  // Recorded so `copse rm` can stop this command before it removes the worktree.
  const record = join(runDir(cwd), String(process.pid));
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, '');
  try {
    return await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
    });
  } finally {
    rmSync(record, { force: true });
  }
}

// Run the repo's dev command from copse.json.
export function dev(cwd, options) {
  const command = readConfig(cwd).dev;
  if (!command) {
    throw new Error('No dev command. Add one to copse.json in the main checkout: { "dev": "pnpm dev --port @port" }');
  }
  return run(cwd, [command], { ...options, shell: true });
}

// Every checkout of the repo that exists on disk, main first.
function worktrees(cwd) {
  return git(cwd, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n');
      const value = (key) => lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);
      return { path: value('worktree'), branch: value('branch')?.replace('refs/heads/', '') ?? null };
    })
    .filter((tree) => tree.path && existsSync(tree.path));
}

// Each checkout with its branch, first port, and whether a server answers there.
// `port` is null for a worktree copse has not given a slot yet.
export async function list(cwd) {
  const { port: base } = readConfig(cwd);
  const here = git(cwd, 'rev-parse', '--show-toplevel');
  return Promise.all(
    worktrees(cwd).map(async ({ path, branch }) => {
      const saved = savedSlot(path);
      const first = saved === null ? null : base + saved * PORTS_PER_SLOT;
      return { path, branch, port: first, up: first !== null && (await isListening(first)), current: path === here };
    }),
  );
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Stop every `copse run` still going in a checkout. Each one passes the signal to its command.
function stopRuns(cwd, log) {
  const dir = runDir(cwd);
  if (!existsSync(dir)) return;
  for (const pid of readdirSync(dir).map(Number)) {
    // A stale record can name a pid the system has since given to another program.
    const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout;
    if (!command.includes('copse')) continue;
    log(`stop    process ${pid}`);
    process.kill(pid, 'SIGTERM');
    for (const deadline = Date.now() + 5000; isAlive(pid); sleep(50)) {
      if (Date.now() > deadline) throw new Error(`Process ${pid} did not stop within 5 seconds.`);
    }
  }
}

// Stop a worktree's servers, remove it, and delete its branch if it is merged.
// `name` is a branch or a path. `force` also discards uncommitted changes.
export async function remove(cwd, name, { force = false, log = () => {} } = {}) {
  const main = mainWorktree(cwd);
  const target = worktrees(cwd).find((tree) => tree.branch === name || tree.path === resolve(cwd, name));
  if (!target) throw new Error(`No worktree for "${name}". Run copse list to see them.`);
  if (target.path === main) throw new Error('That is the main checkout. copse rm only removes linked worktrees.');

  stopRuns(target.path, log);
  const saved = savedSlot(target.path);
  const first = saved === null ? null : readConfig(cwd).port + saved * PORTS_PER_SLOT;
  if (!force && first !== null && (await isListening(first))) {
    throw new Error(`Port ${first} still has a server that copse did not start. Stop it, or pass --force.`);
  }

  git(main, 'worktree', 'remove', ...(force ? ['--force'] : []), target.path);
  log(`removed ${target.path}`);
  if (!target.branch) return;
  try {
    git(main, 'branch', '-d', target.branch);
    log(`deleted branch ${target.branch}`);
  } catch {
    log(`kept    branch ${target.branch} (not merged)`);
  }
}

const installerFor = (dest) => INSTALLERS.find(([lockfile]) => existsSync(join(dest, lockfile)));

// The install command the worktree needs, or null when the cloned node_modules
// already matches its lockfile.
export function installCommand(source, dest) {
  const installer = installerFor(dest);
  if (!installer) return null;
  const [lockfile, manager, args] = installer;
  const sourceLock = join(source, lockfile);
  const upToDate =
    existsSync(join(dest, 'node_modules')) &&
    existsSync(sourceLock) &&
    readFileSync(sourceLock).equals(readFileSync(join(dest, lockfile)));
  return upToDate ? null : [manager, ...args];
}

// Fill the worktree containing `cwd` with clones of the main checkout's node_modules,
// .env files, and the config's extra paths, then install if its lockfile differs.
// `canClone` is replaceable so tests can act like a disk without copy-on-write.
export function hydrate(cwd, { install = true, log = () => {}, canClone = canCloneBetween } = {}) {
  const source = mainWorktree(cwd);
  const dest = git(cwd, 'rev-parse', '--show-toplevel');
  if (source === dest) {
    throw new Error('This is the main checkout. Run hydrate inside a linked worktree.');
  }

  const config = readConfig(source);
  const cloneable = canClone(source, dest);
  const manager = installerFor(dest)?.[1];
  const dependencies = dependencyMode({ cloneable, manager, install, hardlink: config.hardlink });
  const verbs = { clone: 'clone  ', hardlink: 'link   ', copy: 'copy   ' };

  for (const path of sharedPaths(source, config.clone)) {
    const target = join(dest, path);
    // Only node_modules is ever hard-linked. A linked .env or data file would change
    // in every worktree at once.
    const mode = basename(path) === 'node_modules' ? dependencies : cloneable ? 'clone' : 'copy';
    if (existsSync(target)) {
      log(`skip    ${path} (already there)`);
    } else if (!existsSync(dirname(target))) {
      log(`skip    ${path} (this branch has no ${dirname(path)})`);
    } else if (mode === 'install') {
      log(`skip    ${path} (this disk can't clone, so ${manager} install fills it)`);
    } else {
      const started = Date.now();
      copyTree(join(source, path), target, mode);
      let shims = 0;
      if (lstatSync(target).isDirectory()) {
        // Tool caches bake in the main checkout's absolute paths. They rebuild on first use.
        for (const cache of ['.vite', '.cache']) {
          rmSync(join(target, cache), { recursive: true, force: true });
        }
        shims = retargetBinShims(target, source, dest);
      }
      log(`${verbs[mode]} ${path} (${Date.now() - started}ms${shims ? `, ${shims} bin shims` : ''})`);
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
  const [program, ...args] = command;
  const { status, error } = spawnSync(program, args, { cwd: dest, stdio: 'inherit' });
  if (error) throw error;
  if (status !== 0) throw new Error(`${program} install failed in ${dest}`);
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
