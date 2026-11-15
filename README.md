# copse

Git worktrees that start in under a second, without a second copy of `node_modules`, and that can each run their own dev server.

`copse add` creates a normal git worktree, then fills it with copy-on-write clones of the main checkout's `node_modules` folders and `.env` files. A clone shares disk blocks with the original until one side changes. Each worktree gets a fixed block of ports, and `copse run` starts its servers there.

Measured on an APFS Mac, against a plain `git worktree add` plus a warm-cache install:

| Repo | Plain worktree + install | `copse add` |
| --- | --- | --- |

## Usage

```sh
copse add <branch> [path] [--base <ref>] [--no-install]
copse list
copse rm <branch|path> [--force]
copse dev
copse run -- <command...>
copse port
copse hydrate [--no-install]
```

`add` checks out `<branch>` if it exists locally or on a remote. Otherwise it creates the branch from `--base`, or from `HEAD`. The default path is `../<repo>-<branch>`, with slashes in the branch name turned into dashes.

`hydrate` does the clone step for a worktree that something else created, such as `git worktree add` or an editor. Run it inside that worktree.

`list` shows every worktree with its branch, its port, and whether a server answers there:

```
   BRANCH         PORT  SERVER  PATH
   main           3000  -       /code/app
*  feat-login     3010  up      /code/app-feat-login
```

`rm` stops the servers that `copse dev` or `copse run` started in the worktree, removes it, and deletes its branch if git considers it merged. An unmerged branch stays. A worktree with uncommitted changes is refused unless you pass `--force`. Plain `git worktree remove <path>` works too, and either way the port block is freed.

## Settings

Settings live in `copse.json` in the main checkout. Every worktree reads that one file, so edits apply right away, without a commit. All keys are optional:

```json
{
  "port": 5173,
  "dev": "pnpm dev --port @port",
  "clone": ["data"]
}
```

- `port` is the first port of the main checkout's block. The default is 3000.
- `dev` is the shell command `copse dev` runs, with the same `PORT` variable and `@port` placeholders as `copse run`. An agent can then start any repo's server with `copse dev`.
- `clone` lists extra git-ignored paths to clone into each new worktree, such as a local database folder. Don't list a database that a running server is writing to.

## Ports

Every checkout owns a block of 10 ports. The main checkout starts at 3000, the first worktree at 3010, the next at 3020. A worktree keeps its block until it's removed, and the next new worktree takes the lowest free one. Change the start for a repo with `port` in `copse.json`.

`copse port` prints the first port of the block. `copse run` starts a command with that port in `PORT`, and replaces `@port` and `@port+1` through `@port+9` in the command:

```sh
copse run -- pnpm dev                                  # Next.js reads PORT
copse run -- pnpm dev --port @port --strictPort       # Vite ignores PORT
copse run -- env API_PORT=@port+1 pnpm dev:api        # a second server
```

Before starting, `run` checks that nothing listens on the first port, and fails if something does. This stops a second copy of a server, or a server that would drift to another free port. The check is skipped when the command names only `@port+N`, because that may be a port it connects to. Give such servers a flag that fails on a taken port, like Vite's `--strictPort`.

### What a project needs for several instances

copse gives each worktree its own ports. The project still has to use them. In testing, these broke with several instances running:

- **A hardcoded proxy target.** A Vite config with `proxy: { '/api': 'http://127.0.0.1:4680' }` sends every worktree's API calls to whichever server holds 4680. Read the port from the environment instead: `` target: `http://127.0.0.1:${process.env.API_PORT ?? 4680}` ``. Then start the web server with the same variable.
- **A fixed `port` in a config file.** It wins over `PORT`. Use `@port` on the command line, or read `process.env.PORT` in the config.
- **Shared services.** Cloned `.env` files are identical, so every worktree uses the same external database, queue, or API keys. A database file inside the repo, like `data/app.db`, is not cloned, so each worktree starts with an empty one.

## What it clones

Anything git ignores in the main checkout that is either a folder named `node_modules`, at any depth, or a file named `.env` or `.env.*`. Build output such as `dist` and `.next` stays behind.

On macOS, each folder is cloned with one `clonefileat(2)` call, made through the system Perl because Node has no binding for it. If that fails, copse falls back to a per-file `cp -c`.

pnpm writes the checkout's absolute path into its `.bin` shims. copse rewrites the cloned shims to the worktree's path, so a missing package can't resolve from the main checkout.

Tool caches at `node_modules/.vite` and `node_modules/.cache` stay behind. Vite's cache holds absolute imports from the main checkout, and both rebuild on first use.

It never overwrites a file or folder the worktree already has. It skips a nested `node_modules` when the branch has no parent folder for it.

## When it installs

After cloning, copse compares the worktree's lockfile with the main checkout's. If they match, it's done. If they differ, it runs the package manager that owns the lockfile (`npm`, `pnpm`, `yarn`, or `bun`), which only has to fetch the packages that changed.

## Limits

- The main checkout needs an installed `node_modules`. copse clones what is there.
- Clones need a copy-on-write filesystem: APFS on macOS, or Btrfs or XFS with reflinks on Linux. Elsewhere `cp` falls back to a full copy. The Linux path is untested.
- `du` counts a clone at full size. Compare `df` before and after to see what a worktree costs.
- Native build output inside `node_modules`, such as an Expo package's Xcode `.DerivedData`, keeps the main checkout's paths. Native builds from a worktree are untested.
- Stopping only the process that holds a port can leave a watcher such as `tsx watch` running. Use `copse rm`, or stop the `copse run` or `copse dev` process. It passes the signal to the command.
