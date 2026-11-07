# Magical Hamster Tutorial

This guide explains how to install, configure, and use Magical Hamster in Obsidian.

Magical Hamster is a local meeting assistant for Obsidian. It listens to a meeting from your microphone, transcribes it live, turns shorthand notes into cleaner bullets, writes summaries, and lets you ask questions using both the meeting transcript and your vault.

The goal is simple: turn a meeting into useful notes without losing time after the call.

---

## 1. What Magical Hamster does

Magical Hamster gives you a meeting workflow in the sidebar:

- Live transcript from your microphone
- Shorthand-to-bullet enhancement while you type or after the fact
- Meeting summary when you stop recording
- Questions answered from the transcript and your notes
- A companion note saved with the enhanced notes, summary, transcript, and answers
- Local stats about tokens processed on-device

This is meant to minimize manual note cleanup after a meeting.

---

## 2. Requirements

Before using it, make sure you have:

- macOS on Apple Silicon
- Obsidian 1.13 or later
- Ollama installed and running
- Node 20 or later for the speech worker

You also need the speech runtime installed once for the transcription engine.

---

## 3. Install and configure it

### Step 1: pull the required local models

Run:

```bash
ollama pull gemma4:12b
ollama pull embeddinggemma-2:270m
```

These are the local AI models used for writing and retrieval.

### Step 2: install the plugin

In Obsidian, open Settings, Community plugins, Browse, search for "Magical Hamster", install it and enable it.

### Step 3: set up speech recognition

Once, in Terminal (Applications, Utilities), with Node.js 20 or later installed:

```bash
curl -fsSL https://github.com/baconbro/magical-hamster/releases/latest/download/setup-speech.mjs -o setup-speech.mjs && node setup-speech.mjs
```

This installs the speech library and downloads the speech model used for transcription (about 490 MB), into `~/Library/Application Support/magical-hamster`, outside your vault. Settings, Magical Hamster, Speech shows the same command, with a button that copies it.

---

## 4. First run in Obsidian

After installing the plugin:

1. Open your vault in Obsidian.
2. Open the Magical Hamster sidebar from the ribbon.
3. If you are starting a new meeting, click New meeting.
4. Select the meeting section in your daily note if applicable.

The app works around a daily note and a meeting section. It links your session to the relevant section in the daily note and stores the generated companion note next to it.

You can also take the meeting's notes in any other note. Open it, and the Notes tab offers two buttons:

- **Use this note**: you type in that note, the companion note sits beside it, and the link line goes into that note.
- **Write the meeting into it**: no companion note. The enhanced notes, summary, Q&A insights and transcript are added as sections below your own text in that note.

---

## 5. How meetings are detected

Magical Hamster looks for meetings in your daily note based on headings and names.

A section is considered a meeting when it looks like one of these patterns:

- A heading containing a wiki link
- A heading starting with a meeting word such as 1:1, Ad Hoc, Prep, Steering, or Rencontre
- A heading containing a name from your entity registry

Examples:

- ### 1:1 [[Jane Example]]
- ### [[Steering Board]]

A heading like “Budget Prep” is not considered a meeting unless the meeting word is positioned as part of the heading pattern.

You can also start a meeting from a short standalone line such as:

```text
1:1 Maya
```

This starts a meeting until the next meeting heading or block.

---

## 6. Start a meeting session

Once a meeting is selected:

- click New meeting to create a session,
- choose a meeting section if needed,
- begin recording from the sidebar or command palette.

The sidebar is your main control center. It shows:

- the live transcript,
- the current meeting context,
- notes enhancement output,
- summaries,
- answers to your questions.

---

## 7. Live transcription

When recording starts, the plugin listens to your microphone and streams the transcript in the sidebar.

This is the best workflow for live meetings:

- keep the sidebar open while you record,
- see what was said in real time,
- continue to type shorthand notes in your daily note,
- let the system improve them using the transcript.

The transcript is local to the session and remains tied to the meeting context.

---

## 8. Enhance notes

This is one of the most important features.

### What “Enhance” does

You can write shorthand notes like:

```text
Discussed scope
Need design review
Timeline revised
```

Magical Hamster can turn that into cleaner, grounded notes based on the transcript.

It can work:

- on demand when you press Enhance
- live while you type
- as new speech arrives

The plugin attempts to turn each line into a clearer bullet while staying grounded in the actual meeting.

### Important behavior

The app is careful not to overwrite your note arbitrarily:

- It does not edit your original shorthand text.
- It writes generated text into the companion note between markers.
- If you manually edit the generated section, the plugin may stop overwriting it to protect your changes.

This is designed to keep your notes safe while allowing enhanced output to be regenerated when needed.

---

## 9. Summaries and action items

When you stop the recording, Magical Hamster can generate a summary.

Typical outputs include:

- executive summary
- recap
- action items
- key decisions

This summary is saved in the companion note and can be regenerated on demand if needed.

This is especially useful for follow-up after meetings where you want to capture the important outcomes quickly.

---

## 10. Ask questions during or after the meeting

The Ask feature lets you ask questions about:

- the meeting transcript,
- the current discussion,
- your vault content.

Examples:

- What did we decide about the launch date?
- What is the customer risk mentioned in the call?
- Which notes reference this project previously?

The system answers with source grounding, so responses are tied back to what was said or what is stored in your notes.

A neat feature: questions that appear naturally in the meeting may be offered as clickable chips so you can answer them with one click.

---

## 11. Companion note workflow

Before a companion note exists, the session can still work in the sidebar. Recording, enhancement, summaries, and Q&A all function before the note is created.

When you click Create companion note, Magical Hamster does two things:

1. creates a note in the companion folder (Meetings by default), named like:
   `Meetings/Mtg-YYYY-MM-DD — <Title>.md`
2. adds a link line back to the meeting section in your daily note

This companion note becomes the main place where the model output is stored.

It includes:

- enhanced notes
- summary
- Q&A insights
- transcript

The companion note remains a normal note you can edit and refine.

---

## 12. What is kept vs. what is replaced

The companion note uses special markers so the plugin knows where it can safely write generated content.

### Safe behavior

- The plugin only updates content inside its own markers.
- It does not rewrite unrelated parts of the note.
- Your manually edited text is preserved if possible.

### When it stops writing

If you change a marker or alter generated content outside the plugin’s expected boundaries, the app may stop auto-writing to that region to avoid overwriting your manual edits.

In that case, you can:

- restore the markers,
- press Check the note again,
- or regenerate the content manually.

This is a protective feature, not a bug.

---

## 13. Daily note integration

One of the strongest parts of Magical Hamster is how it ties everything back to your daily note.

It can:

- recognize a meeting section in your daily note,
- attach the companion note to that section,
- create backlinks between the daily note and the companion note.

This keeps the meeting tied to your normal working rhythm instead of living in a detached note silo.

---

## 14. Recommended workflow

For a typical meeting, this is the cleanest process:

1. Open today’s daily note.
2. Select or start a meeting section.
3. Click New meeting.
4. Start recording.
5. Keep typing shorthand notes as needed.
6. Let live enhancement refine the bullets.
7. Stop the recording.
8. Review the generated summary.
9. Ask follow-up questions if needed.
10. Create the companion note.
11. Review the saved markdown and adjust as necessary.

This gives you a finished, source-backed meeting record in a few minutes.

---

## 15. Best practices

### Keep your shorthand useful

Use short but meaningful lines such as:

```text
Need customer approval
Pricing still open
Next milestone in two weeks
```

This makes the enhancement step much more reliable.

### Keep the transcript clean

A quiet meeting environment helps with transcription quality. The plugin works best when the microphone is close and the audio is clear.

### Use the companion note as the main output

Treat the companion note as the canonical generated artifact. It stores the enhanced notes, transcript, summary, and answers in one place.

### Preserve manual edits

If you want to rewrite a generated bullet, do it in the companion note. The plugin is built to avoid clobbering manual edits when possible.

---

## 16. Limitations

The project is intentionally focused, and it has a few limits:

- microphone-only capture in the current version
- no calendar import
- no audio retention
- only one generation model request at a time
- the system is designed for personal, local meeting capture rather than large multi-user conference capture

These are noted in the project README and are part of the current scope.

---

## 17. Troubleshooting

### The plugin does not detect the meeting

Check whether your heading pattern matches the expected meeting format. Meeting sections need to be recognizable by heading text or a linked entity.

### Enhancement is slow

This can happen if the local model is busy or the transcript is large. You can use the Enhance button instead of live enhancement, or adjust the typing pause settings if available.

### The note stops updating

This usually means the plugin detected that you manually edited generated content or changed the markers. Restore the correct marker pair and run the note check again.

### No transcript appears

Make sure:

- Obsidian has microphone access,
- the speech runtime is installed,
- Ollama is running,
- the project is configured with the correct local runtime setup.

---

## 18. Typical use cases

Magical Hamster is ideal for:

- 1:1 meetings
- project check-ins
- brainstorming sessions
- internal prep calls
- stakeholder updates
- leadership or team syncs

It is especially useful when you want your meetings to become structured notes without spending extra time cleaning them up manually.

---

## 19. Summary

Magical Hamster turns Obsidian into a local meeting workspace:

- record the discussion,
- capture a live transcript,
- enhance your shorthand notes,
- summarize the call,
- answer questions from the discussion and your vault,
- save the result into a companion note tied to your daily work.

If you want a fast, local-first way to turn meetings into usable knowledge, this is the core workflow it provides.

---

## 20. Next steps

If you want to try it:

1. install the plugin,
2. open the dev vault,
3. create a meeting session,
4. record a short sample,
5. test the Enhance, Summary, and Ask features,
6. then use it in your real vault.

Once you understand the flow, the project becomes a practical AI note-taking assistant rather than just a transcription tool.
