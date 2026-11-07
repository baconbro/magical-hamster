# Development guide

Magical Hamster is an Obsidian plugin: a meeting assistant that listens through the microphone, transcribes on-device, turns shorthand typed in the daily note into enhanced notes, and writes its output to one companion note per meeting.

## Getting started

Node 22.18 or later (the tests run TypeScript under `node --test`, which needs the type stripping Node turned on by default in 22.18; CI uses 24, see `.nvmrc`) and pnpm. On a Mac with Apple silicon:

```bash
pnpm install
```
```bash
pnpm setup:stt
```

`pnpm setup:stt` installs the speech runtime from this repository: `sherpa-onnx-node`, the Nemotron model, and the worker scripts from `stt/`, then runs a self-test. It is the same script users run as `setup-speech.mjs`, which `pnpm build` makes from it with the worker embedded (`scripts/build-setup.mjs`). Add `--dry-run` to see what it would do. Run it again after changing anything in `stt/`: it copies the new worker and skips the download.

Try the plugin in the synthetic vault before a real one:

```bash
pnpm dev:vault
```
```bash
pnpm install:plugin ./dev-vault
```

In Obsidian: *Open folder as vault*, choose `dev-vault`, turn on community plugins. The dev vault's own settings (written by `pnpm dev:vault`) use its folders: dailies and companions in `00 Inbox`, an entity registry in `40 Resources`. Open today's note, put the cursor under a meeting heading, and open the sidebar from the ribbon.

`pnpm install:plugin` makes a development build: one that reloads itself when the next `pnpm install:plugin` copies a new one beside it, once no meeting would lose anything (`src/host/selfReload.ts`, only where the `.selfreload` file it writes is). The first install over an older build needs the plugin turned off and on once. `pnpm build` alone makes the release build, which has neither the self-reload nor the random build name it compares: the same source must give the same `main.js`.

To check the models on this Mac (PASS or FAIL against what Live Enhance needs: an enhance call in 6 s or less, a query embedding in 200 ms or less):

```bash
pnpm bench:llm
```

To replay a 16-bit WAV through the speech worker and read the transcript:

```bash
pnpm bench:stt recording.wav
```

## Releasing

A release is a git tag equal to the version, without a `v`. `.github/workflows/release.yml` builds it and publishes a GitHub release with `main.js`, `manifest.json`, `styles.css` (what Obsidian installs) and `setup-speech.mjs` (what the speech setup command downloads, from the latest release).

```bash
node scripts/release.mjs 0.2.0
```

It sets the version in `package.json`, `manifest.json` and `versions.json`, and prints the commit and tag to push. The workflow refuses a tag that does not match `manifest.json`. The community directory reads `manifest.json` from the default branch, and rebuilds the release from the tagged source to compare.

## Layers

```
src/types.ts            every shared contract (types only)
src/settings.ts         defaults and small pure helpers
src/util/               hash, text, language and loopback-address helpers (pure)

src/editor/sectionAt    which part of the daily note is a meeting (pure)
src/editor/entities     the entity registry parser (pure)
src/notes/              companion template, merge, sanitizers, write queue (pure)
src/llm/                Ollama client, scheduler, prompts, enhance, summary, Q&A (pure)
src/rag/                EmbeddingGemma 2 client, chunker, vector store, indexes (pure)
src/stt/protocol        the frame protocol; sttProcess supervises the child (pure, injected spawn)
stt/                    the speech worker, plain CommonJS, runs outside Obsidian

src/session/            the one orchestrator; talks to the world through interfaces
src/host/, src/editor/liveCapture, dailyNote, dailyLink, src/notes/textTarget, companionStore,
src/stt/nodeSttSource, src/audio/, src/settings-tab.ts, src/main.ts
                        Obsidian, WebAudio and child_process adapters
src/ui/                 React; a pure function of (HamsterState, HamsterController)
src/ui/miniMarkdown     the sidebar's own Markdown renderer: DOM nodes only, no HTML parser

dev/                    browser harness: the UI and session against fake hosts
test/                   unit tests; the adapters run against a stub of `obsidian`
```

"Pure" means: no `obsidian` import at run time, no `node:*` import, no DOM. Those modules run unchanged in Electron, in a browser and under `node --test`.

## Conventions

- **Imports are relative and carry the file extension**: `import { x } from '../util/text.ts'`. No path aliases. This is what lets Node run the tests directly.
- **Types are imported with `import type`.** `verbatimModuleSyntax` is on.
- **Erasable TypeScript only.** No `enum`, no `namespace`, no constructor parameter properties (`constructor(private x: T)`). Node strips types; it does not transform.
- **A pure module takes its dependencies as arguments** (a clock, a fetch, a spawn function). It never reaches for `Date.now()`, `setTimeout` or `fetch` directly when a test would need to control them: use the `Clock` from `types.ts`.
- **`src/types.ts` is the contract.** If a module needs it changed, change it deliberately and update every user in the same commit.
- **Layout with `flex`/`grid` and `gap`.** Tailwind's `space-x-*`, `space-y-*` and `divide-*` compile to zero-specificity selectors and lose to the scoped reset, so they do nothing here.
- **No Tailwind directive in a `.css` file.** `@tailwind`, `@source`, `@custom-variant` and `@theme` live in `src/styles/tailwind.ts`, which the build adds to `styles.css` before Tailwind reads it: the community directory lints the source CSS, and a CSS linter that does not know Tailwind reports each one as an unknown at-rule. A test fails if one comes back.
- **A scrolling element that contains `sr-only` text must be `relative`.** `sr-only` is absolutely positioned; without a positioned ancestor it is laid out against Obsidian's page and makes it scrollable.
- **Utilities work only under `.mh-root`.** Obsidian loads the plugin's stylesheet for the whole app, so the utilities are generated inside `:where(.mh-root)` (`src/styles/styles.css`): a bare `.hidden` or `.container` would restyle notes and other plugins. A utility class does nothing on the root element itself or on anything drawn outside the sidebar; a modal uses Obsidian's own classes.
- **Only the tab on screen is mounted.** A tab's `useState` is lost when the tab changes, and the session changes it too (a summary that starts after Stop). What the user is in the middle of, such as a question being typed, is held with `useKept` from `src/ui/context.tsx`.
- **`stt/` is copied into the runtime directory by `pnpm setup:stt`.** A change to the worker reaches an installed runtime only after running it again.
- **Text a model wrote is never handed to Obsidian's Markdown renderer, and never to `innerHTML`.** The model reads vault notes as sources, and a note can tell it what to write. In the state, model text has been through `disarmCode()`; the sidebar draws it with `renderMiniMarkdown` (`src/ui/miniMarkdown.ts`), which builds text, emphasis, code, lists and headings node by node and shows a link, an image or a wikilink as its text. Everything saved to a companion goes through `sanitizeLlmOutput()` (`src/notes/sanitizeLlmOutput.ts`), which ends with `inertMarkdown()`: saved text cannot become an image or an HTML tag either. A new place that shows or saves model text uses these, and a new `UiHost.renderMarkdown` keeps to the same rule.
- **Comments say why**, not what.
- **No real vault text in the repo.** Tests and the dev vault use synthetic notes that copy the *shape* of real ones.

## Names that must not drift

| Thing | Value |
|---|---|
| Plugin id | `magical-hamster` |
| Region markers in companions | `<!-- hamster:begin enhanced -->` … `<!-- hamster:end enhanced -->` (also `summary`, `qa`, `transcript`) |
| Origin of the plugin's own editor writes | `hamster` (`EDIT_ORIGIN`) |
| Link line in the daily | `↳ [[Mtg-2026-10-09 — 1-1 Jane Example\|Meeting notes]]` |
| Companion frontmatter key | `hamster_source: "<title>#<ordinal>"` |
| Runtime directory | `~/Library/Application Support/magical-hamster/` on a Mac; `%APPDATA%\magical-hamster\` on Windows; `$XDG_DATA_HOME/magical-hamster/` (`~/.local/share/magical-hamster/`) elsewhere |
| Setting that names another runtime directory | **Runtime folder**, as the settings tab and `pnpm setup:stt` both print it |
| Installer's environment variables | `HAMSTER_VAULT`, `HAMSTER_CONFIG_DIR` |
| Frame magic | `M`, `H` |

## Rules that protect the vault

1. Nothing is written to the vault until the user clicks **Create companion note**.
2. The plugin adds exactly one line to the daily note and never edits any other user text.
3. Companion writes only touch the text between a region's markers, and the `updated` date in the frontmatter. A damaged marker pair means the write is skipped, never repaired.
4. No Vault API write to a file within 2.5 s of an edit in an editor: Obsidian saves 2 s after the last change and the later write wins. The one-file mode edits properties as text lines, never through `processFrontMatter`.
5. No wikilinks and no `- [ ]` checkboxes in generated text by default: both are indexed by other tooling in the vault.
6. Generated text is saved inert: no image, no HTML tag, no code block or inline query that another plugin would run. Links to http(s) and mailto addresses written by the model are kept: nothing fetches them until clicked. Links with any other scheme (`obsidian://`, `file:`) are reduced to their text.
7. Models, the speech runtime, the index, stats and bench audio live outside the vault.
8. Meeting content goes to the Ollama address and nowhere else. When that address is not this computer, the user is told (see below).

## What the session promises the user

All of it is in `src/session/meetingSession.ts`, and the README tells the user the same. A change there keeps these, or changes the README with them.

- **A recorded meeting without a companion is not dropped silently.** Its transcript is only in memory and no audio is kept. `mayLeave` refuses the first request that would leave it (`selectSection`, `newMeeting`, `endMeeting`) with "This meeting is not saved yet…"; the same request again discards it only between 1 s and 15 s after that notice, so a double click never does, and a refusal does not stay armed; the notice stays up for those 15 s. Only speech counts: bullets, a summary and answers can be made again. Quitting Obsidian is not a request: nothing asks.
- **A damaged marker pair sets its region aside** (`MeetingState.detachedRegions`): the host answers `detached`, the other regions are still written, and the sidebar names the section. `createCompanion` on a note that exists reads it again (the **Check the note again** button): a region whose pair is whole again is saved to from then on; one still damaged gets "The companion note is still damaged…".
- **A region edited by hand is not written over.** Obsidian reports every change to a note as `modify`, the plugin's own writes included, so `handleVaultChange` cannot tell them apart by the event: the session remembers what each region held when it last wrote or read it (`noteHeld`, and `flying` for the write under way) and reads the note 2.5 s after a change, and again before every batch that replaces a region (an edit typed in the companion's own editor raises no `modify` until Obsidian saves, two seconds later). A bullet reworded in place goes into the Enhance engine, edited insights become what later ones are added to. Any other edit sets the region aside (`MeetingState.editedOutside`) with a notice, until `createCompanion` is asked for again: that replaces the region with what the sidebar shows. The transcript region is only appended to.
- **What an earlier visit saved is not replaced unasked.** A transcript is in memory for one visit, so a later visit could only rewrite the notes from less. When the note already holds enhanced notes or a summary (`priorEnhanced`, `priorSummary`; assumed until the note has been read), Live Enhance, a change of style and the summary at Stop show their result in the sidebar only. The user is told once that the note keeps the earlier ones, and **Enhance** or **Summarize** pressed after that replaces them. No summary is started by itself at Stop over an earlier one. Bullets that are one per line of the section are taken as those lines' own instead (`EnhanceEngine.seed`), but only when each can be tied to its line: it still carries the line's kept terms (a figure by its number, a name whatever its accents) and shares a word with it. Known limit: an edit made between two visits that changes only a lone digit or swaps one common word is not seen.
- **Live Enhance runs for typed changes only.** The editor binding marks an update `userTyped` when one of its transactions carries the `input` or `delete` user event; `handleDailyUpdate` passes that to `EnhanceEngine.setItems(items, typed)`. Text that arrives another way (the file read at start, a sync, the plugin's own link line, the echo from another pane) updates the lines without scheduling a run. New transcript still schedules one while Live Enhance is on.
- **An Ollama address that is not this computer is said, not refused.** `src/util/loopback.ts` decides (`localhost`, `*.localhost`, 127.0.0.0/8 and `[::1]` are this computer). `main.ts` shows a notice at every start, and one that stays until dismissed when the address arrives by sync; the settings tab warns under the field as the address is typed, and puts it into effect only once the typing is over (the field is left, Enter, the settings close); the session publishes `HamsterState.ollama.remoteHost` for the sidebar.

## What the real models taught (2026-10-13)

Measured on gemma4:12b, embeddinggemma-2:270m and the Nemotron recognizer through the plugin's own modules. Each point has a test; the prompts and constants carry the reason next to them.

- **Prompts show the shape with examples, never a placeholder.** Given the format line `N. **Topic:** text`, gemma4:12b wrote the word "Topic" as the label of 295 bullets in 320 and put the text on the next line. The prompt now shows two example lines; `parseEnhance` still recovers the real label when a model writes a placeholder (`PLACEHOLDER_LABEL`), and drops a label of more than six words, which is the line copied.
- **A figure is one term.** `keepTerms` split "1 200" at its space and asked the model to keep "200"; it obliged ("200 usagers" for 1 200). Grouped figures, decimals and times are now one term each, and days and months count as terms whatever their case.
- **An answer cut by the token limit is not a bullet.** `ChatResult.doneReason` is `length` then; the engine leaves that line pending and sends it again with twice the room. The room itself grows with the length of the line.
- **A fresh bullet must still be about its line** (`holdsLine`): a word of the line in its text (the label alone proves nothing, the model often copies the line there) and the line's figures, days and months. Otherwise it is not kept, and the excerpts it was written from are never offered to that line again (`Entry.distrusted`). This caught "by Thu" turned into "by Friday" by the transcript, and lines taken over by an unrelated excerpt.
- **Similarity floors belong to an embedding model.** EmbeddingGemma scores unrelated text 0.51 to 0.75, so the old floor of 0.35 filtered nothing and every line, even about something never said, got three excerpts. `src/rag/relevance.ts` holds floors per model family, and an Enhance excerpt must also be within 0.04 of the line's best one. A model nobody measured keeps the old floors. Tests use `UNMEASURED_FLOORS` through `SessionDeps.retrievalFloors`, since the fake embedder's scores are not EmbeddingGemma's.
- **A short line or question is read by its everyday words.** `shorthandLang` knows days, months and the common words of notes, and leaves a line that switches language inside it as written. `questionLanguage` falls back to typing cues (a space before "?", an accent, an elision) and then to English: told only to answer "in the language of the question", gemma4:12b answered two-word English questions in the language of the sources.
- **Sources an answer does not cite are found, not assumed.** `citedSources` reads ranges, "and", full-width digits; without a number it lists the sources that hold the answer's figures and names (`supportingSources`), and none for an answer about the meeting itself. Brackets that name the transcript are dropped from the answer.
- **The speech worker resets only after a final, and re-feeds what it heard since the last word.** See "Why the recognizer's own endpoints are off" in `protocol/segments.md`. A reset at the recognizer's own endpoint lost the first words of the next sentence at two boundaries in three; no reset at all lost the start of a sentence after a long silence. The worker cuts finals out of the token list itself, then resets at the pause and feeds the recent audio again.
- **A question is a sentence, not a segment.** A final holds up to twenty seconds of speech and the recognizer rarely ends one on "?". `questionsIn` takes each sentence that ends in "?" or opens like a question and finds question forms in mid-sentence ("est ce que", "avez vous", "when will it"); when a final does arrive with `closes: "?"`, the session also makes a chip of the previous final's last sentence.
- **A dying worker does not take its sentence with it.** The partial on screen when the worker crashes becomes a final.
- **Numbers said in words become digits once, when a final arrives** (`src/util/numbers.ts`). The recognizer writes "soixante dix pour cent"; left as words, gemma4:12b summarized it as 60 %. The conversion reads French 70 to 99, "et un", "cent(s)", "mille", decimals with "virgule" or "point", and "pour cent", and leaves alone what is also an ordinary word ("un", "neuf" for new, "seize" the verb, "Sept" the month), ranges ("deux et trois", "deux-trois") and coins ("fifty cents"). No number reads across a comma or a full stop.
- **A summary cut by its token limit ends on its last complete line** (`endOnCompleteLine`), and the limit is 2,000 tokens: a four-hour meeting needed more than 1,200.

## Facts about Obsidian the host layer depends on

Read from Obsidian 1.14.4's own bundle and its typings; each one cost a bug or a near miss.

- **An edited note is saved 2 s after the last change**, whoever made the change. A Vault write to that file inside the window is overwritten by the pending save.
- **In Reading view `view.editor` is a stale buffer.** Use the editor only when `view.getMode() === 'source'`.
- **On quit, Obsidian saves its editors before plugin tasks run**, and the 2 s debounced save dies with the window. A write a plugin makes into an editor during its quit task must be followed by an explicit save (`TextTarget.saveEditors()`).
- **While a view loads another note, `view.file` is already the new note and its editor still holds the previous note's text.**
- **A note open in several panes echoes each change into the others** as a transaction with `userEvent: 'set'`.
- **A deferred leaf has no `MarkdownView` yet.** `getActiveViewOfType(MarkdownView)` is null while the sidebar has focus: iterate `getLeavesOfType('markdown')`.
- **Templater rewrites every new note about 300 ms after creation.** Create a note in one write and hold further writes for a second.
- **The core Daily notes plugin with no folder set** creates the daily in the default location for new notes, not the vault root.
- **`daily-notes.json` survives switching the core Daily notes plugin off.** The file alone does not say who creates the daily notes. `core-plugins.json` holds the state: a map of plugin id to on or off, or in older vaults the list of the ids that are on. With the core plugin off, Periodic Notes is asked first (`pickDailyConfig`).
- **`MarkdownRenderer.render` runs every plugin's post-processors on what it draws** (Dataview executes a `dataviewjs` block), and an image or a raw HTML tag is fetched the moment it is drawn. It is not for text a model wrote.
- **Every change to a note comes back as a `modify` event, the plugin's own writes included.** Nothing in the event says who made it.
- **A vault can have another config folder than `.obsidian`** on a device (Settings, Files and links, Override config folder), and the old `.obsidian` often stays behind, unread. `app.vault.configDir` is the one in use.
- `editor.cm` (the CodeMirror view) exists at run time but not in the typings: feature-detect it.

## Commands

```bash
pnpm typecheck
```
```bash
pnpm test
```
```bash
pnpm build
```
```bash
pnpm dev
```
```bash
pnpm install:plugin ./dev-vault
```
```bash
pnpm install:plugin /path/to/vault .obsidian-desktop
```

`pnpm install:plugin` builds, then copies the plugin (`main.js`, `manifest.json`, `styles.css`) and `THIRD_PARTY_NOTICES.md` into the vault's plugin folder. It refuses any path that is not an Obsidian vault. The vault can also be named in `HAMSTER_VAULT`, and a config folder that is not `.obsidian` as the second argument or in `HAMSTER_CONFIG_DIR`.

`pnpm dev` serves the browser harness: by default the real session on fake hosts, with `?mode=fake` a scripted store with named states. Its query parameters are listed at the top of `dev/harness.tsx`. The fake vault reports the plugin's own writes back to the session, as Obsidian does (`FakeNotesHost.onWrite`); an edit by hand can be played from the console, as described at the end of that file.

A single test file: `node --disable-warning=ExperimentalWarning --test test/sectionAt.test.ts`.

There is no lint command. The Obsidian community directory runs `eslint-plugin-obsidianmd` over every submission, and that scan is the lint: the release commits of 0.1.1 to 0.1.4 are what it found. There is none locally because typescript-eslint supports TypeScript below 6.1, while this repository typechecks with TypeScript 7 (the native compiler, tsgo). Anyone who wants one can add a `lint/` pnpm workspace package with its own TypeScript 6, `eslint`, `typescript-eslint`, `eslint-plugin-obsidianmd` and `obsidian`, and run eslint from there against `src/`; the sources need no change for it.
