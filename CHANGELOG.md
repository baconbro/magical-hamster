# Changelog

What a user or a contributor could notice, newest first, in the form of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). A version is the plugin's (`manifest.json`), and a release is a tag equal to it. The notes of a release on GitHub are its section here (`scripts/release-notes.mjs`), so a version's section is written before it is tagged.

## [Unreleased]

### Fixed

- "Write the meeting into it" no longer writes the properties through the Vault while the note's editor holds unsaved changes: the pending save could drop them. An existing `date` in that note is replaced only when the day differs, and string `tags` are split like Obsidian does.
- The notice refusing to leave an unsaved recorded meeting now stays up for the whole 15 s in which a second request discards it.
- Settings read from a hand-edited or synced data.json are validated field by field: a wrong type falls back to its default, and an address with a user name or password is refused.
- The knowledge index detects an index.json and a vectors.bin saved by different runs and rebuilds, instead of pairing vectors with the wrong passages.
- The transcript index stops re-requesting every failed embedding on every chunk, and is rebuilt when the embedding model or its dimensions change.
- The last transcript batch is no longer lost silently when the companion cannot be written as a meeting ends.
- A partial sentence from a stopped recording no longer lands in the next meeting.
- A companion renamed while a batch is written no longer gets the lines twice.
- A heading with thousands of blanks no longer stalls indexing.

### Changed

- Speech setup installs sherpa-onnx-node at an exact version with npm's install scripts off, verifies the model against a published or pinned SHA-256 (fails closed; `--sha256`, `--no-verify`), downloads over https only with a stall guard, refuses archives with links, and records the plugin version it came from.
- The settings and the sidebar show the setup command for the installed plugin version, and the plugin says when the speech runtime is older than itself.
- The minimum Context size is 4096.
- Links the model writes with a scheme other than http(s) or mailto are saved as text.
- Node 22 or later (20 is end of life).
- The stylesheet no longer declares variables on `:root`.
- The release workflow builds with a read-only token and publishes in a separate job.
- The default runtime folder follows the platform on Windows and Linux.

### Added

- A React error boundary in the sidebar, with "Reload view".
- A warning when the microphone's audio context is suspended by the system.
- A warning when transcription falls more than 30 s behind.
- SECURITY.md, CONTRIBUTING.md, this changelog, Dependabot.

## [0.1.4] - 2026-11-06

### Fixed

- The two warnings the directory's scan of 0.1.3 left, both in the settings tab. Obsidian's `Setting` has a `then()` method, so a callback that returned the Setting read as returning a promise: those callbacks now return nothing.
- The deprecated `display()` is gone: with Obsidian 1.13 or later, which the manifest requires, the tab is drawn from `getSettingDefinitions()`, and the tests draw it the same way.

## [0.1.3] - 2026-11-06

### Changed

- Clears the warnings of the directory's scan of 0.1.2. Settings search: the tab gives Obsidian 1.13 its settings as definitions (`getSettingDefinitions`), drawn by the existing code, so they show in Obsidian's settings search; edits being typed are saved before a redraw after a sync, as before.
- DOM built with Obsidian's `createEl` helpers (the Markdown renderer, the theme probe, the browser test page). No Tailwind directive in a `.css` file: they live in `src/styles/tailwind.ts` and the build adds them to `styles.css`; the built stylesheet is unchanged.
- The window's timers and fetch, not `globalThis`; promise rejections are Errors that keep the original value's fields; no unbound methods; types for the audio worklet's globals.

## [0.1.2] - 2026-11-06

### Changed

- The one error of the directory's scan of 0.1.1, in the browser test page (`dev/`): styles set directly on elements are in the page's own stylesheet now.
- From the same scan, in the plugin's code: no needless regex escapes or type assertions, control characters dropped without a control-character regex, React's `SubmitEvent` in place of the deprecated `FormEvent`, typed settings from `loadData`, and subscriptions called through their objects.

## [0.1.1] - 2026-11-06

### Added

- Release files carry signed build provenance (artifact attestations). `main.js` opens with the notices of the packages it bundles, and the notices file names the speech setup, ONNX Runtime and the model's licence.

### Changed

- From the community directory's scan of 0.1.0 and a review against its rules: no static inline styles (the first-write dialog has classes of its own), the note commands show only when a note can hold the meeting, typed folder paths go through `normalizePath`.
- Sentence case for "live enhance" and "debug tab"; no ui-* system font names; Tailwind's directives marked for the linter.

## [0.1.0] - 2026-11-06

### Added

- Magical Hamster: a meeting assistant for Obsidian. Live transcript on the Mac, enhanced notes from shorthand, summaries and Q&A grounded in the vault, through Ollama and sherpa-onnx, all on the user's own computer.
