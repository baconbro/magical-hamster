# Phase 2: system-audio helper (not built yet)

Phase 1 captures the microphone only. Over speakers it hears everyone in the
room and cannot tell them apart; with headphones it hears only you.

Phase 2 adds a small Swift app that captures what the Mac is playing (the other
participants in Teams, Meet or Zoom) and sends it to the same speech worker,
tagged as a second source.

## What it has to do

- Capture system audio with a Core Audio process tap (`CATapDescription`, macOS 14.2+).
- Capture the microphone with `AVAudioEngine`, with voice processing on when the
  output device is the speakers, so the far end is not transcribed twice.
- Send both as the frames described in [`protocol/segments.md`](../protocol/segments.md):
  microphone as source `0`, system audio as source `1`.

Nothing else changes: the worker already keeps one recognizer stream per source,
and the transcript already shows a different icon per source.

## Constraints found during planning

- **It must be its own app bundle, launched with `open -a`.** macOS attributes a
  child process's permission requests to its parent. Obsidian's `Info.plist` has
  no `NSAudioCaptureUsageDescription`, so a helper spawned directly by the plugin
  is silently denied system audio.
- **It must be signed with a stable identity.** An ad-hoc signature changes with
  every build and macOS forgets the permission each time. A self-signed
  code-signing certificate from Keychain Access is enough; no Apple Developer
  membership and no notarization for a locally built app.
- **Build with the Command Line Tools, not Xcode 16.4**, which cannot target this
  macOS:
  `DEVELOPER_DIR=/Library/Developer/CommandLineTools swift build -c release`
  with `swift-tools-version: 6.2` and `platforms: [.macOS(.v26)]`.
- `Info.plist`: `LSUIElement`, `NSMicrophoneUsageDescription`,
  `NSAudioCaptureUsageDescription`, `LSMinimumSystemVersion` 26.0.

## Spike before writing any helper code

1. Does a helper launched with `open -a` get its own permission prompts?
2. Does `open -W` return when the helper is killed?
3. Does `--stdout` capture the helper's output?
4. Does `codesign` work from a non-interactive shell with a self-signed identity?

The answers decide how the plugin supervises the helper (a heartbeat over a Unix
socket is the planned crash detector, whatever `open -W` does).
