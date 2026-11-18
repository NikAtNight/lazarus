# How lazarus works

## What it clones

Anything git ignores in the main checkout that is either a folder named `node_modules`, at any depth, or a file named `.env` or `.env.*`. Build output such as `dist` and `.next` stays behind. Add more paths with `clone` in `lazarus.json`.

On macOS, each folder is cloned with one `clonefileat(2)` call, made through the system Perl because Node has no binding for it. If that fails, lazarus falls back to a per-file `cp -c`. On Linux it uses `cp --reflink`.

pnpm writes the checkout's absolute path into its `.bin` shims. lazarus rewrites the cloned shims to the worktree's path, so a missing package can't resolve from the main checkout.

Tool caches at `node_modules/.vite` and `node_modules/.cache` stay behind. Vite's cache holds absolute imports from the main checkout, and both rebuild on first use. lazarus never reads them, so a large webpack cache doesn't slow it down: a `node_modules` that has one is cloned entry by entry, leaving the cache out.

It never overwrites a file or folder the worktree already has. It skips a nested `node_modules` when the branch has no parent folder for it.

## When it installs

After cloning, lazarus compares the worktree's lockfile with the main checkout's. If they match, it's done. If they differ, it runs the package manager that owns the lockfile (`npm`, `pnpm`, `yarn`, or `bun`), which only has to fetch the packages that changed.

## Disks that can't clone

Cloning needs a copy-on-write filesystem: APFS on macOS, or Btrfs or XFS with reflinks on Linux. ext4, the usual Linux default, can't do it. Neither can a worktree on a different volume from the main checkout. lazarus tests this with one small file, then picks a way to fill `node_modules`:

| Repo | What lazarus does | Disk cost |
| --- | --- | --- |
| pnpm or bun | Skips the copy and runs the install. Both link files from their own store. | Small |
| npm or yarn | Copies `node_modules` in full. | Full size |
| npm or yarn with `"hardlink": true` | Hard-links every file to the main checkout's copy. | Small |

Hard links share one file between checkouts, so a tool that edits a file in place inside `node_modules`, such as `patch-package`, changes it in all of them. An install is safe, because it replaces files. That risk is why `hardlink` is off by default. `.env` files and `clone` paths are always real copies.

With `--no-install`, pnpm and bun repos get a full copy too.

## Ports

Every checkout owns a block of 10 ports. The main checkout starts at 3000, the first worktree at 3010, the next at 3020. A worktree keeps its block until it's removed, and the next new worktree takes the lowest free one. The block is recorded in the worktree's git directory, so `git worktree remove` frees it too.

Before starting, `lazarus run` checks that nothing listens on the first port, and fails if something does. This stops a second copy of a server, or a server that would drift to another free port. The check is skipped when the command names only `@port+N`, because that may be a port it connects to. Give such servers a flag that fails on a taken port, like Vite's `--strictPort`.

`lazarus run` sets `PORT`, `LAZARUS_PORT`, and `LAZARUS_SLOT`, and passes `SIGINT`, `SIGTERM`, and `SIGHUP` on to the command. `lazarus rm` uses that to stop a worktree's servers before removing it.

## Running the tests

```sh
npm test
```

CI runs the suite on Ubuntu with Node 20, 22, and 24, on macOS with Node 22, and on Btrfs and XFS loopback disks to check that clones share blocks.
