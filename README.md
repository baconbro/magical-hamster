# Magical Hamster

A meeting assistant that lives in Obsidian. You keep typing shorthand in your notes; the plugin listens, transcribes on your Mac, and turns each line into a clean bullet using what was said. After the meeting it writes a summary. During it, you can ask questions answered from the transcript and from your own notes.

Everything runs on your own computer: the writing and retrieval models through [Ollama](https://ollama.com) (**Gemma 4 12B** and **EmbeddingGemma 2** by default), and speech recognition with NVIDIA's **Nemotron 3.5 ASR** model through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), multilingual, French and English in the same sentence.

## What it does

- **Live transcript** from the microphone, in the sidebar.
- **Enhance**: one bullet per shorthand line, grounded in the transcript. On demand, or live as you type and as new speech arrives.
- **Summary** when you stop: executive summary, recap, or action items.
- **Ask**: questions about the meeting or your vault, answered with sources. Questions heard in the meeting are offered as one-click chips.
- **One companion note per meeting**, holding the enhanced notes, the summary, kept answers and the transcript.
- **Stats**: tokens processed on your computer, per week.
- **Debug** (off by default): each exchange with the model, as plain text, kept in memory only.

## Requirements

- **A Mac with Apple silicon** (M1 or later) for speech recognition. The plugin installs on any desktop, but transcription only runs on these Macs.
- Obsidian 1.13 or later, desktop.
- [Ollama](https://ollama.com), running. A Mac with 16 GB of memory or more is recommended for the default model.
- [Node.js](https://nodejs.org) 22 or later (a current LTS: 22 or 24), to run speech recognition. Obsidian cannot run it itself.

## Install

**1. The plugin.** In Obsidian, Settings, Community plugins, Browse, search for "Magical Hamster", install and enable it.

**2. The models**, in Terminal (about 8 GB and 0.4 GB):

```bash
ollama pull gemma4:12b
```
```bash
ollama pull embeddinggemma-2:270m
```

**3. Speech recognition** (see below), once.

**4. Use it.** Open the Magical Hamster sidebar from the ribbon, put the cursor under a meeting heading in your daily note (or press **New meeting**), and press **Record**. macOS asks for microphone access for Obsidian the first time.

## Speech recognition

The plugin does not download or install anything itself. Speech recognition is set up once with a command you run in Terminal (Applications, Utilities); Settings, Magical Hamster, Speech shows it with a button that copies it:

```bash
curl -fsSL https://github.com/baconbro/magical-hamster/releases/latest/download/setup-speech.mjs -o setup-speech.mjs && node setup-speech.mjs
```

It downloads the setup script attached to the plugin's latest release, and runs it with your Node.js. The script:

- installs the speech library, `sherpa-onnx-node` and `sherpa-onnx-darwin-arm64`, from the npm registry (about 10 MB);
- downloads the Nemotron 3.5 ASR streaming model (int8, 560 ms) from the [sherpa-onnx releases on GitHub](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models), about 475 MB, checks its SHA-256 against the one GitHub publishes for it, and unpacks it (about 685 MB);
- writes the speech worker's scripts, transcribes a test recording, and records the result in `runtime.json`.

Everything goes into `~/Library/Application Support/magical-hamster/`. Add `--dry-run` to see what it would do without doing it, and `--runtime <folder>` to use another folder (then name it in the settings, **Runtime folder**). Run it again to repair the runtime or to update the speech worker after a plugin update: it skips what is already there.

## Privacy, network and files

**What leaves your computer.** Nothing, with the default settings: the plugin talks only to Ollama at `http://localhost:11434`. There is no telemetry and no analytics.

- If you set the **Ollama address** to another computer, your transcripts, notes, passages from your vault and questions are sent to it. The plugin says so under the setting, in the sidebar, and in a notice at every start.
- The speech setup command downloads from the npm registry (`registry.npmjs.org`) and GitHub (`github.com`, and `api.github.com` for the model's checksum), only when you run it.
- Pulling models (`ollama pull`) is between you and Ollama.

**Files outside the vault.** `~/Library/Application Support/magical-hamster/` holds the speech runtime (about 700 MB), the knowledge index of the folders you choose to index, and the token stats. It is kept there so that it is not synced with your vault. Delete the folder to remove all of it; the plugin then shows how to set speech up again.

**Recording.** The plugin hears what your microphone hears, and keeps no audio: only the text, in the sidebar and, once you save it, in the meeting's note. Ask the people in the meeting before you record them; recording laws differ by place.

## What it writes, and when

1. Nothing, until you click **Create companion note**. Recording, Enhance, summaries and answers all work in the sidebar before that. Until then a recorded meeting exists only in the sidebar. Leaving it (another meeting, **New meeting**, **End**) is refused once, with a notice; the same action again a moment later (not a double click) discards it. Quitting Obsidian discards it without asking.
2. Then one note, `Meetings/Mtg-YYYY-MM-DD — <Title>.md` (the folder is a setting), and **one link line** at the end of the meeting's section in your daily note. The first time, it shows you both and asks. A meeting started with **New meeting** is not tied to a section: it gets the note and no line, until you link it to a section.
   - **A meeting typed in another note.** Open that note and press **Use this note** in the Notes tab (or run the command **Use the open note for the meeting**). Its heading under the cursor is the meeting's section; without one, the whole note is. The link line goes into that note, not the daily, and Enhance follows what you type there.
   - **One file instead of two.** **Write the meeting into it** (or the command **Write the meeting into the open note**) adds the four sections below your text and four properties (`type`, `date`, `hamster_source`, `tags`) to that note. Nothing above the sections changes, and no companion is created. Refused for the daily note and for a note that is already a companion.
3. After that it only changes the text between its own markers in the companion (`<!-- hamster:begin enhanced -->` … `<!-- hamster:end enhanced -->`), and the `updated` date in its properties.

The companion stays yours to edit:

- **Markers.** If a marker is changed, deleted, doubled or moved, the plugin stops saving to that section rather than guess, and never repairs the marker. The sidebar says which section. Put the pair back and press **Check the note again**: saving resumes.
- **Text between the markers.** A bullet you reword in place and what you change in the Q&A insights are kept and built on. After any other edit to the enhanced notes or the summary, the plugin stops writing to that section, so your text stays, and says so. To have the section replaced with what the sidebar shows, save there again from the sidebar, or run the command **Create companion note** again. The transcript is only ever added to.
- **Coming back to a meeting.** A transcript is in memory for one visit. On a later visit (after a restart, or after another meeting) the plugin has less to write from, so it does not replace the enhanced notes or the summary already saved unless you ask. The new ones are shown in the sidebar and a notice says the note keeps the earlier ones: press **Enhance** or **Summarize** again to replace them. Stopping a recording writes no summary over an earlier one.

It never creates the daily note, never edits your shorthand, and by default puts no `[[wikilinks]]` and no `- [ ]` tasks in the text it generates, so that text adds nothing to linked mentions or task queries. A task you type (`- [ ] …`) keeps a ☐ mark on its enhanced bullet (☑ once you tick it in your note). With the setting **Tasks as checkboxes** on, it is a real checkbox instead, and so are the action items; task tools then list the task twice, so tick it in your own note: the companion follows. The companion's only link is its `links:` property, which points back to the daily note: the companion is listed among the daily note's backlinks. **Extra properties** in the settings adds your own (`area: work`, say) to each new companion.

What the model writes is drawn in the sidebar and saved to the companion as inert text: an image, an HTML tag or code that another plugin would run (a Dataview query, for instance) appears as the characters it is written with. Obsidian fetches an image the moment it draws one, and a note the model was given as a source could tell it to write one whose address carries your meeting.

## How a meeting is found in the daily note

- A heading of level 1 to 3 that contains a wikilink, starts with a meeting word (`1:1`, `Meeting`, `Sync`, `Standup`, `Prep`, `Réunion`, `Rencontre`; the pattern is a setting), or contains a name from your entity registry is a meeting: `### 1:1 [[Jane Example]]`, `### Sync Platform team`. `### Budget Prep` is not: the word has to come first.
- In a note without headings, a short line on its own such as `1:1 Maya` starts a meeting that runs to the next one, whatever blank lines are in between.
- Other headings are listed under "Other sections" and can be used as a meeting with one click.

**Entity registry** (optional, a setting): a note with one table per `## ` section (People, Projects, …), whose columns are found by their header, `canonical`, `wikilink`, `aliases` and `active`. Its names mark headings as meetings, and become a meeting's attendees and projects.

## Limits of this version

- **Speech recognition on Apple silicon Macs only.**
- **Microphone only.** With headphones it hears only you. Over speakers it hears everyone but cannot tell who is speaking.
- No calendar import.
- No audio is kept.
- One generation model means one request at a time: an answer pauses live enhance for a few seconds.

A guided walkthrough is in [`docs/TUTORIAL.md`](docs/TUTORIAL.md).

## Licence

The plugin is under the MIT licence ([`LICENSE`](LICENSE)). The packages bundled into `main.js` are listed with their licences in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

What the speech setup downloads is not part of the plugin, and comes under its own licences:

- sherpa-onnx, `sherpa-onnx-node` and `sherpa-onnx-darwin-arm64`: [Apache License 2.0](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE).
- ONNX Runtime, inside `sherpa-onnx-darwin-arm64`: [MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE).
- The Nemotron 3.5 ASR streaming model, by NVIDIA: [OpenMDW-1.1](https://openmdw.ai/license/1-1/) ([model card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)). It places no restriction on the transcripts it produces.

## Development

Building from source, the test suite, the browser harness and the benchmarks are described in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).
