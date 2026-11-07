# Security

## Reporting a vulnerability

Report it privately: on the repository's **Security** tab on GitHub, **Report a vulnerability**. That opens a draft advisory only the maintainer can read; it is answered there, and the fix goes out as a release. Please do not open a public issue for it. Say what the plugin does, what it should do instead, and how to see it. A synthetic note or transcript that shows it helps; real vault text does not belong in a report.

## Supported versions

The latest release. A fix is a new version, which Obsidian offers from the community directory; earlier versions are not patched.

## What the plugin trusts

Everything runs on the user's own computer, and what the plugin writes and sends is listed in the README under "Privacy, network and files" and "What it writes, and when". Three things come from outside the plugin's own code, and each is handled on its own terms.

### 1. Text in the notes the model reads

The model reads vault notes as sources: the shorthand under the meeting heading, the notes it links to, the passages found for a question. A note can tell the model what to write, so what the model writes is never treated as the user's own text:

- The sidebar draws it with its own renderer (`src/ui/miniMarkdown.ts`), which builds text, emphasis, code, lists and headings node by node and shows a link, an image or a wikilink as its text. It never uses Obsidian's `MarkdownRenderer`, which runs every plugin's post-processors on what it draws and fetches an image the moment it is drawn, and never `innerHTML`.
- Everything saved to a note goes through `sanitizeLlmOutput()` (`src/notes/sanitizeLlmOutput.ts`), which ends with `inertMarkdown()`: no image, no embed, no HTML tag, no code block or inline query that another plugin would run. A link whose scheme is not `http`, `https` or `mailto` is saved as its text.
- By default the generated text holds no wikilinks and no `- [ ]` tasks, so it adds nothing to linked mentions or task queries.

Not defended against: a source that makes the model summarise badly or answer wrongly. The user reads what it writes.

### 2. The Ollama address

Everything the plugin sends (transcript, shorthand, passages from the vault, questions) goes to the Ollama address in the settings and nowhere else. With the default, `http://localhost:11434`, nothing leaves the computer. Another address is not refused but said: `src/util/loopback.ts` decides what counts as this computer (`localhost`, a name under `.localhost`, 127.0.0.0/8 and `[::1]`), and for any other host the settings tab warns under the field, the sidebar shows the host, and a notice appears at every start, one that stays until dismissed when the address arrived by sync rather than being typed on this computer. Settings read from `data.json` are checked field by field, a hand-edited or synced file included: a value of the wrong type falls back to its default, and an address with a user name or password in it is refused.

### 3. The speech runtime

The plugin never downloads or installs anything itself. Speech recognition is set up by a script the user fetches from the plugin's release and runs with their own Node (`setup-speech.mjs`, built from `scripts/setup-stt.mjs`; the settings and the sidebar show the command for the installed plugin version). The script:

- installs `sherpa-onnx-node` from the npm registry at one exact version, with npm's install scripts off, so nothing from the registry runs during the installation;
- downloads the Nemotron model from the sherpa-onnx releases on GitHub, over https only, and checks its SHA-256 against the one GitHub publishes for the asset or the one pinned in the script. A mismatch deletes the download and stops; with no checksum to check against it stops too (`--sha256` names one, `--no-verify` skips the check);
- refuses an archive that holds links, and unpacks only into the runtime folder;
- records the plugin version it came from, so that the plugin can say when the runtime is older than itself.

The runtime lives outside the vault: `~/Library/Application Support/magical-hamster/` on a Mac, a folder of the same kind on Windows and Linux, or the **Runtime folder** named in the settings. Nothing in it is synced. The plugin runs the worker found there with the Node recorded in `runtime.json`. Deleting the folder removes all of it.

## Out of scope

Vulnerabilities in Ollama, in sherpa-onnx or its model, in Node.js or in Obsidian itself: report those to their projects. The plugin cannot fix them; a report here is only passed on.
