# Contributing

The layout, the conventions and the rules that protect the vault are in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Read it first: a change is read against them, whatever else it does.

## Before a large change

Open an issue and say what you have in mind. The plugin keeps a small set of promises (what it writes, when, and what leaves the computer), and a change that touches one is easier to talk about before it is written than after.

## Working on it

Node 22.18 or later and pnpm:

```bash
pnpm install
```
```bash
pnpm typecheck
```
```bash
pnpm test
```

`pnpm test` runs every unit test under `node --test`; the tests that need a Mac with Apple silicon skip elsewhere. `pnpm build` makes the release build, `pnpm install:plugin <vault>` puts a development build into a vault, and the development guide has the browser harness and the benchmarks. There is no lint command; the guide says why.

## What goes into the repository

- **No real vault text.** Tests, fixtures and the dev vault use synthetic notes that copy the shape of real ones, never their content. A transcript, a meeting title or a name from a real vault goes into neither a test, nor a commit message, nor an issue.
- **Comments say why**, not what.
- **A commit's subject is a plain sentence**, no prefix, no period at the end; its body says why the change was made. `git log` shows the voice.
- **A new dependency comes with its reason** in the pull request. The packages bundled into `main.js` are listed in `THIRD_PARTY_NOTICES.md` with their licences, and a new one is added there.

A security problem goes through [`SECURITY.md`](SECURITY.md), not an issue.
