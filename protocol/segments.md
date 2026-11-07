# The speech worker protocol

Audio goes into the speech worker as binary frames on its standard input. Transcript events come back as JSON lines on its standard output. This document is the contract between the two sides. It is written for whoever sends audio to the worker: today the plugin (`src/stt/protocol.ts`, `src/stt/sttProcess.ts`), in Phase 2 also the Swift helper that captures system audio.

```
Obsidian renderer (microphone)          Swift helper (system audio, Phase 2)
        │  source 0                             │  source 1
        └──────────────┬────────────────────────┘
                       │  stdin: binary frames
                       ▼
   <node> <runtime>/worker.cjs --model <dir> [--lang fr-CA]
                       │  stdout: one JSON object per line
                       ▼
               Obsidian renderer (transcript)
```

The worker is `stt/worker.cjs` with `stt/frames.cjs`, `stt/resample.cjs` and `stt/lang.cjs`, copied to the runtime directory by `pnpm setup:stt`.

## Starting the worker

```
<node> <runtime>/worker.cjs --model <model dir> [--lang auto|fr-CA|fr-FR|en-US] [--threads 2]
```

| Argument | Meaning |
|---|---|
| `--model <dir>` | The unpacked model directory (`encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt`). Required unless `--fake`. |
| `--lang <code>` | Pins the language of every stream. Full locale codes. Default `auto`: the model detects it. |
| `--threads <n>` | Threads for the recognizer. Default 2. |
| `--self-test <wav>...` | Transcribes 16-bit PCM WAV files and exits. See below. |
| `--fake` | Test only. A stand-in recognizer; see below. |
| `--stats-ms <n>` | Test only. Interval of the `stats` line. Default 5000. |

Environment: `DYLD_LIBRARY_PATH=<runtime>/node_modules/sherpa-onnx-darwin-arm64`. The speech library is a native addon and finds its dylibs through it.

The runtime directory is `~/Library/Application Support/magical-hamster/`:

```
worker.cjs  frames.cjs  resample.cjs  lang.cjs
node_modules/sherpa-onnx-node/
node_modules/sherpa-onnx-darwin-arm64/
models/<model dir>/
models/<model dir>.sha256
runtime.json     { node, runtimeDir, model, modelDir, chunkMs, sha256, sherpaVersion, workerVersion, installedAt }
```

`runtime.json` is written only after a self-test passed: the worker transcribed one of the model's test recordings, or, for a model that came without any, loaded the library and the model on a second of silence. The plugin reads it by itself and needs no setting for it: it runs the worker with `node` (unless its **Node path** setting names another one) and hands `modelDir` to `--model`. It takes the directory it found the file in as the runtime directory, whatever `runtimeDir` says, and follows a `modelDir` recorded inside that directory when the directory was moved. Only a runtime installed somewhere else than the directory above has to be named, in the **Runtime folder** setting. `workerVersion` is the plugin version the setup script came from (null when the script was run from a checkout without one): the plugin compares its major.minor with its own version and asks for the setup to be run again after a plugin update.

## Frames (stdin)

Every frame is an 8-byte header followed by its payload.

| Offset | Size | Field | Value |
|---|---|---|---|
| 0 | 2 | magic | `0x4D 0x48` ("MH") |
| 2 | 1 | version | `1` |
| 3 | 1 | source | `0` microphone, `1` system audio, `255` control |
| 4 | 4 | payloadBytes | unsigned 32-bit, little-endian, at most 1,048,576 |

Frames follow each other with nothing in between. A frame may be written in several pieces, but frames from two writers must never interleave: whoever owns the pipe writes whole frames.

### Audio frames (source 0 or 1)

The payload is mono PCM, signed 16-bit, little-endian, at the sample rate announced by that source's `hello`. Any frame length works; 100 ms per frame is what the plugin sends and what the worker's cadence is tuned for. The worker converts to float in [-1, 1], resamples to 16 kHz when needed, and decodes in 100 ms slices whatever the frame size. Before decoding it raises quiet speech: this model reads absolute levels, and loses words below about -40 dBFS. The gain follows the loudest recent speech (its peaks to about -6 dBFS), drops at once when the input gets louder, is held for 2 s, then rises by 3 dB a second, never above +30 dB, and never lowers anything. It starts afresh at each `hello`.

### Control frames (source 255)

The payload is one UTF-8 JSON object with a `type`.

| Message | Meaning |
|---|---|
| `{"type":"hello","source":"mic","sampleRate":48000}` | Announces a source (`"mic"` or `"system"`) and its sample rate (an integer from 8000 to 192000). Must come before that source's first audio frame. The first hello creates the source's recognizer stream. A later hello for the same source (a device change) starts a new resampler at the new rate; the source's clock and its open utterance carry on. |
| `{"type":"flush"}` | Finalizes the open utterance of every source now, without waiting for silence. Everything received before the flush belongs to the utterances it closes. |
| `{"type":"bye"}` | Flushes, then the worker exits with code 0. |

Closing stdin has the same effect as `bye`. So do `SIGTERM` and `SIGINT`, except that audio still waiting to be decoded is dropped.

### What is an error

| Condition | Result |
|---|---|
| Wrong magic, a version other than 1, or a payload over 1 MiB | Fatal. Open utterances are finalized, then `{"type":"error","code":"protocol",...}`, then exit code 4. The framing is lost, so the worker cannot continue. |
| Audio for a source that has not said hello | The frames are ignored. One `error` event with code `protocol` per source; the worker keeps running. |
| A control frame that is not a JSON object with a `type`, a hello with an unknown source or an unusable sample rate | Ignored. One `error` event with code `protocol`; the worker keeps running. |
| An unknown control `type`, or a source byte other than 0, 1 and 255 | Ignored with a note on stderr. This is what lets a newer sender talk to an older worker. |
| An audio payload with an odd number of bytes | The last byte is dropped, with a note on stderr. |

### Example bytes

A hello for system audio at 48 kHz (53 bytes of JSON), then four samples `0, 1, -1, 258` from that source, then bye:

```
4d 48 01 ff 35 00 00 00  {"type":"hello","source":"system","sampleRate":48000}
4d 48 01 01 08 00 00 00  00 00 01 00 ff ff 02 01
4d 48 01 ff 0e 00 00 00  {"type":"bye"}
```

A 100 ms frame at 48 kHz carries 4,800 samples, 9,600 bytes: header `4d 48 01 01 80 25 00 00`.

## Events (stdout)

One JSON object per line, UTF-8, terminated by `\n`. Nothing else is written to stdout; diagnostics go to stderr. A reader should still skip lines that do not parse, because a native library could print to stdout on its own.

### `ready`

```json
{"type":"ready","model":"sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11","chunkMs":560}
```

Sent once, when the recognizer is loaded and the worker starts reading stdin. `model` is the name of the model directory, `chunkMs` the model's chunk size: text cannot appear sooner than that after speech. Frames written before `ready` are not lost, they wait in the pipe.

### `segment`

```json
{"type":"segment","source":"mic","t0":12.34,"t1":14.02,"text":"on se revoit jeudi","isFinal":false,"lang":"fr","langSource":"heuristic"}
```

| Field | Meaning |
|---|---|
| `source` | `"mic"` or `"system"` |
| `t0`, `t1` | Where the recognized speech starts and ends, in seconds since that source's first audio sample. Counted in samples, not wall-clock time: each source has its own clock, and a gap in the audio is a gap the clock does not see. Two decimals. |
| `text` | The utterance so far (partial) or complete (final). Punctuation and capitalization come from the model. Never empty. |
| `isFinal` | `false` for a partial: the text may still change. `true` once the utterance is over; the next segment of that source starts a new one. |
| `lang` | Optional. `"fr"` or `"en"`, guessed from function words in `text`. Absent when the text is too short or too mixed to call. |
| `langSource` | `"heuristic"` whenever `lang` is present. |
| `closes` | Optional, on a final only. The punctuation (`"?"`, `"."`) that closes the PREVIOUS final of the same source. The recognizer writes a sentence's closing mark only once the next sentence has started, so after a pause it arrives at the head of the next piece; the worker takes it off that text and sends it here. A `"?"` makes a question of the last sentence of the previous final. |

Partials are sent only when the text changed, and at most four per second of audio per source (at least 250 ms of that source's audio between two partials). A final is sent after 0.8 s of silence following speech, when the open piece has run for 20 s (cut at its last full sentence when it has one, and the rest stays open), on `flush`, on `bye`, when stdin closes, or on a signal. A piece with no text produces nothing.

`t0` and `t1` come from the recognizer's token times, on the source's own clock, and a final never starts before the previous one ended. With a library that gives no usable token times they come from when the text appeared (`t0` is then one chunk before the first text). Treat them as accurate to about half a second: measured on real speech, `t0` is late by 0.25 s (median) and `t1` by 0.3 s.

### `stats`

```json
{"type":"stats","rtf":0.15,"backlogMs":120}
```

Every 5 seconds, with or without audio: it is also the heartbeat. `rtf` is decode time divided by audio time over the last interval (0 when there was no audio). `backlogMs` is audio received but not yet decoded, over all sources.

The worker never pushes back on stdin: if it falls behind, audio queues inside the worker and `backlogMs` grows.

### `error`

```json
{"type":"error","code":"model_missing","message":"..."}
```

| Code | Meaning | Then |
|---|---|---|
| `model_missing` | The model directory is missing or incomplete. | exit 2 |
| `addon_load_failed` | `sherpa-onnx-node` could not be loaded. `message` carries the underlying error, usually a dylib that was not found. | exit 3 |
| `protocol` | See "What is an error". | exit 4, or keeps running |
| `lang_unsupported` | The model does not have the `--lang` language, or the library cannot pin one. Sent once. | keeps running with automatic detection |
| `internal` | Anything else: bad arguments, an exception in the recognizer. | exit 1 |

### A slow reader

When the reader does not keep up and the pipe fills, the worker drops partials and `stats` lines until the pipe drains. Finals and errors are never dropped. The worker does not wait on stdout.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Finished: `bye`, stdin closed, `SIGTERM` or `SIGINT`. (A self-test cut short by a signal exits 1.) |
| 1 | Anything not listed below. |
| 2 | The model directory is missing or incomplete. |
| 3 | `sherpa-onnx-node` failed to load. |
| 4 | Protocol error. |

The model directory is checked before the library is loaded. With both missing, the worker exits 2.

On the way out the worker waits up to one second for stdout to drain. The last finals can therefore reach the reader after the process has exited: read stdout to its end.

## Self-test

```
<node> worker.cjs --model <dir> --self-test clip.wav [more.wav ...]
```

Each file (16-bit PCM WAV, any rate, mono or stereo mixed down to mono) goes through the same frame handler as live audio, preceded by 0.5 s of silence and followed by a flush. stdout gets one `segment` line per final (no `ready`, no partials, no `stats`), then:

```json
{"type":"selftest","ok":true,"finals":3,"seconds":12.4,"rtf":0.14}
```

Exit code 0 only when at least one final was produced and the run reached its summary line: a `SIGTERM` or `SIGINT` during a self-test ends it with exit code 1 and no summary. `pnpm setup:stt` gives the self-test five minutes, then kills it and reports a failure. Segment times include the 0.5 s of leading silence and run on from one file to the next.

## The fake recognizer (test only)

`--fake` needs no library and no model. It follows the signal's energy in 10 ms steps: anything above an RMS of 0.02 is speech. While speech lasts it reports `"speech 0.5s"`, the duration growing; 0.6 s of silence ends the utterance with a final `"speech <duration>s"` whose `t0` and `t1` are the first and last voiced step. `ready` says `{"model":"fake","chunkMs":100}`. It exists for the tests (`test/worker.test.ts`, `test/runtime.test.ts`, `test/scripts.test.ts`) and for `scripts/bench-stt.mjs --fake`. Its output is deterministic. The browser harness (`pnpm dev`) does not start the worker at all: its transcript comes from a scripted source.

## What the plugin's supervisor does with this

`SttProcess` (`src/stt/sttProcess.ts`) is the reference sender:

- It waits up to 20 s for `ready`, then sends a hello for each source it knows, then audio. The hellos are written before the `ready` state is announced, so audio sent from a state callback still follows them.
- Any event resets a 15 s heartbeat; when it expires the worker is killed and restarted (after 1, 2, then 4 s; at most three restarts in five minutes), and the hellos are sent again.
- A worker counts time from the first sample it receives, so a restarted worker starts its clocks at zero. The supervisor keeps count of the audio it was offered for each source, sent or not, and adds what came before a worker's first sample to that worker's `t0` and `t1`. The segments it hands on are therefore in seconds since the recording began, across restarts.
- Exit codes 2 and 3, and the `model_missing` and `addon_load_failed` events, mean "not installed": no restart.
- To stop, it sends `bye`, closes stdin, waits 2 s, then sends `SIGKILL`.
- As a backstop it also reports `lang_unsupported` when the worker's stderr contains `Unsupported language`, the line sherpa-onnx logs before falling back to automatic detection.

A Phase 2 helper does not need any of this. It needs: one hello with `"source":"system"` and its real sample rate, audio frames with source byte 1, and a new hello whenever its capture format changes.

## Recognizer notes

The recognizer is NVIDIA Nemotron 3.5 ASR Streaming 0.6B (multilingual, int8) run by sherpa-onnx through the `sherpa-onnx-node` package. These notes record what was checked against primary sources on 2026-10-10, and what could not be. Neither the package nor the model was installed to check them: everything marked "not confirmed" is handled defensively in the worker.

### The package

- `sherpa-onnx-node` 1.13.8, main file `sherpa-onnx.js`. It exports, among others, `OnlineRecognizer`, `LinearResampler`, `readWave`, `version`. The prebuilt addon comes through the optional dependency `sherpa-onnx-darwin-arm64`. Source: https://unpkg.com/sherpa-onnx-node@1.13.8/package.json, https://unpkg.com/sherpa-onnx-node@1.13.8/sherpa-onnx.js
- `sherpa-onnx-darwin-arm64` 1.13.8 holds `sherpa-onnx.node` (0.6 MB), `libsherpa-onnx-c-api.dylib` (4.3 MB), `libsherpa-onnx-cxx-api.dylib` (0.2 MB), `libonnxruntime.dylib` (29 MB), plus `index.js`, `package.json`, `README.md`. Source: https://unpkg.com/sherpa-onnx-darwin-arm64@1.13.8/?meta
- `addon.js` tries, in order, `../build/Release/sherpa-onnx.node`, `../build/Debug/sherpa-onnx.node`, `./node_modules/sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`, `../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`, `./sherpa-onnx.node`. When all fail it throws "Could not find sherpa-onnx-node" and, on macOS, asks for `export DYLD_LIBRARY_PATH=<...>/node_modules/sherpa-onnx-darwin-arm64:$DYLD_LIBRARY_PATH`. The examples' README says the same. Source: https://unpkg.com/sherpa-onnx-node@1.13.8/addon.js, https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md
- Not confirmed: which install names the dylibs use to refer to each other. `scripts/fix-sherpa-rpath.mjs` reads them with `otool` instead of assuming, and was exercised on synthetic libraries that fail the same way (a bare name and an `@rpath/` reference).

### The streaming API

From https://unpkg.com/sherpa-onnx-node@1.13.8/streaming-asr.js:

- `new OnlineRecognizer(config)`, then `createStream()`, `isReady(stream)`, `decode(stream)`, `isEndpoint(stream)`, `reset(stream)`, `getResult(stream)` (the addon's JSON, parsed).
- On a stream: `acceptWaveform({ samples: Float32Array, sampleRate })`, `inputFinished()`, `setOption(key, value)`, `getOption(key)`, `hasOption(key)`.
- `acceptWaveform` takes mono float samples "normalized to the range [-1, 1]" and resamples by itself when `sampleRate` differs from the recognizer's. Source: the comment on `SherpaOnnxOnlineStreamAcceptWaveform` in https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/c-api/c-api.h. The worker nevertheless always feeds 16000 Hz from its own resampler: one code path with and without the library, and a low-pass filter we control.
- The addon does expose a resampler (`new LinearResampler(inRate, outRate)`, `resample(Float32Array)`, `flush`, `reset`; https://unpkg.com/sherpa-onnx-node@1.13.8/resampler.js). It is not used, for the reason above.
- When the native constructor fails the addon throws "Please check your config!". The worker reports that as `internal`, exit 1. Many bad-model conditions make the native code exit on its own instead, with a code the worker does not choose.

### The recognizer config

sherpa-onnx's own example, https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_asr_streaming_nemotron.js, uses:

```js
{
  featConfig: { sampleRate: 16000, featureDim: 128 },
  modelConfig: {
    transducer: {
      encoder: `${modelDir}/encoder.int8.onnx`,
      decoder: `${modelDir}/decoder.int8.onnx`,
      joiner: `${modelDir}/joiner.int8.onnx`,
    },
    tokens: `${modelDir}/tokens.txt`,
    numThreads: 2,
    provider: 'cpu',
    debug: 1,
  },
}
```

The worker uses the same with `debug: 0`, and adds what the example leaves at its defaults, with the field names of the other streaming examples (https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_asr_streaming_transducer_microphone.js):

```js
decodingMethod: 'greedy_search',
maxActivePaths: 4,
enableEndpoint: false,
```

The NeMo transducer implementation accepts `greedy_search` and `modified_beam_search` only, takes the feature dimension from the model whatever `featureDim` says, and implements endpointing from trailing blank frames. Hotwords need `modified_beam_search`. Source: https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/online-recognizer-transducer-nemo-impl.h

**Why the recognizer's own endpoints are off.** Acting on one means `reset(stream)`, and measured on this model a reset throws away what the encoder had already heard of the next word: the token for a word is emitted only once most of the word has been heard, so when the endpoint fires 0.8 s after the last token the next word has often begun. With the endpoints on, words were lost at two boundaries in three (French 7 words at 6 of 8 boundaries in two minutes, English 10 at 6 of 9) and the model sometimes wrote non-Latin garbage right after a reset. The worker now keeps decoding and cuts its finals out of the token list, using `num_trailing_blanks` (80 ms frames of silence since the last token) and the token times: on the same recordings 2 and 0 words are lost, and none of the garbage appears. On a 21-minute recording the error rate fell from 23.8 % to 19.0 %.

Decoding straight through a silence has a cost of its own: after 2.6 s of silence the decoder never emitted the first words of the next sentence ("Combien coûte une journée…"). So once a final has ended at a pause, the worker resets the stream and feeds it again the audio heard since the last token (plus 0.24 s), so that a word that has just begun is not lost either. Never in mid-speech: a piece cut at its 20 s limit leaves the rest open. Measured on the same recordings, error rate with the old reset at every endpoint, with no reset at all, and with this:

| Recording | Reset at endpoint | No reset | Reset after a paused final, re-fed |
|---|---|---|---|
| French, 2 min | 3.6 % | 2.9 % | 1.4 % |
| English, 2 min | 3.7 % | 0.8 % | 1.3 % |
| Mixed, 3 min | 13.9 % | 11.9 % | 10.7 % |
| Two-voice meeting, 6 min | 12.6 % | 13.2 % | 11.9 % |
| 21 min, two of its six voices badly heard | 23.8 % | 19.0 % | 20.9 % |

A fresh decoder does not know the sentence before, so the closing mark that would have opened the next piece is seldom written: `closes` is rare in practice, and the session finds questions by their wording (`questionsIn`).

### Language

- The language is a per-stream string option: `stream.setOption('language', 'fr-CA')`. It is read on every decode, so streams of one recognizer can differ. Unset, empty or `auto` selects the model's automatic detection. Source: the example above, and https://github.com/k2-fsa/sherpa-onnx/pull/3671 (merged 2026-06-12).
- The accepted values are the keys of a `prompt_dictionary` stored in the encoder's ONNX metadata, for example `{"auto": 101, "en-US": 0, "ja-JP": 1}`. A value is trimmed, stripped of quotes and angle brackets, `_` becomes `-`, and it is lowercased before the lookup. A bare language (`en`, `fr`) is an alias for one of its locales, chosen by the library, which is why the plugin always sends full locale codes. Source: https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/online-transducer-nemo-model.cc
- An unknown value is not an error for the library: it logs `Unsupported language '<value>' for multilingual NeMo transducer; using auto` and carries on with automatic detection. To report it properly the worker reads `prompt_dictionary` from the encoder file itself (a few small reads of the protobuf's top level) and emits `lang_unsupported` before the library is ever asked. When the file has no dictionary the worker passes the value through, and the supervisor's check of stderr is the backstop.
- The model card lists 40 locales; `en-US`, `en-GB`, `fr-FR` and `fr-CA` are among the 19 it calls transcription-ready. Source: https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b
- In automatic mode the model emits a language tag such as `<en-US>` after terminal punctuation, but sherpa-onnx removes these tags from the text, the tokens and the timestamps. The worker therefore cannot read a language from the result, and `lang` comes from `stt/lang.cjs`, a port of `src/util/lang.ts` (same word lists, same thresholds; a test compares the two).
- Not confirmed: the exact spelling of the keys inside the released files (`fr-CA` is assumed from the model card and the code's own example). The worker normalizes both sides the way the library does, so case and `_` do not matter.

### Results and times

- `getResult` returns at least `text`, `tokens` and `timestamps` (seconds, one per token). The conversion multiplies frame indices by 10 ms and the subsampling factor and adds no offset; a separate `start_time` carries the segment's position. Source: https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/online-recognizer-transducer-impl.h
- `timestamps` restart from zero after `reset(stream)` for this model: the NeMo greedy decoder stamps a token with its frame index plus a `frame_offset` kept in the stream's result, and `Reset` replaces that result with an empty one. Sources: https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/online-transducer-greedy-search-nemo-decoder.cc, https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/online-recognizer-transducer-nemo-impl.h. Observed with the model on 2026-10-13. The worker counts the times after a reset from the audio it feeds again, and falls back to its own sample counters when a token is stamped later than the audio it was heard in.
- On `flush` the worker pads 0.8 s of silence, calls `inputFinished()`, decodes, and uses a new stream for the next utterance, on the assumption that a stream takes no more audio after `inputFinished()`. sherpa-onnx's command-line tool pads a file the same way, 0.5 s before and 0.8 s after by default (https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/sherpa-onnx.cc), and its Node example pads 0.4 s after; the maintainer's review of the pull request notes that the last words were dropped without padding. The self-test uses the same 0.5 s before each file.

### The model files

From the GitHub API, https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/asr-models (the release page is https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models):

| Asset | Bytes | sha256 |
|---|---|---|
| `sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-80ms-int8-2026-06-11.tar.bz2` | 475,274,007 | `fb170128c496db33a1fb9f5f9f823257f42f911224ee218bb429f3c2eaf90a8d` |
| `sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11.tar.bz2` | 475,273,363 | `a81909a1780d84cff16d73c15e13e67d9d81d8839faf14870d507d8499f7a61a` |
| `sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11.tar.bz2` | 475,272,949 | `5f311142337a5c161e92d49f7a3009d8607d3836f39d610bff5307c74d1d2c53` |
| `sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2` | 475,271,763 | `c6bf5e0df765f9d5b43bc9e0536d4b4b3e7d40bdf5ecf13e45f134c51c05ae3a` |
| `sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-1120ms-int8-2026-06-11.tar.bz2` | 475,276,334 | `adbdd5e9fef87300c37cebfcfc4f1ebe56845c860c8a760af0a1dd65ce9beed3` |

Each is about 453 MiB. `pnpm setup:stt` takes the name, size and checksum from the API at install time and compares the download against the checksum. The script also pins this table (`KNOWN_SHA256`, keyed by the asset names it builds itself): when the API cannot be asked, or names an asset without a digest, the download is checked against the pin instead, and the output says which of the two it was verified against. An archive nothing vouches for (a `--model-url` whose name is not in the table, or a newer build) stops the setup before the download unless `--sha256 <hex>` names its checksum from the release page, or `--no-verify` skips the check, which the output then says in so many words. The library is installed as `sherpa-onnx-node@1.13.8` exactly, with npm's install scripts off (neither package has any).

According to the workflow that builds them (https://github.com/k2-fsa/sherpa-onnx/blob/master/.github/workflows/export-nemotron-3.5-asr-streaming-0.6b.yaml), an archive unpacks to one directory named like the archive without `.tar.bz2`, holding `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt`, `README.md` and `test_wavs/` with `ar.wav`, `de.wav`, `es.wav`, `fr.wav`, `ja.wav`, `ko.wav`, `uk.wav`, `vi.wav`, `zh.wav`. There is no English clip, so the self-test in `pnpm setup:stt` uses `fr.wav`.

Not confirmed: the archive's actual contents, since it was not downloaded. The setup script checks for the four model files after extraction. When `test_wavs/` is absent it has nothing to transcribe, so it runs the self-test on a second of silence: that still loads the library and the model (and repairs the library references on exit code 3, as with a recording), and the runtime is recorded once the worker's `selftest` line arrives, whatever its exit code. It then prints how to test with a recording by hand.

The model's license is OpenMDW-1.1.

### Speed

The pull request's author measured a real-time factor of about 0.12 for the int8 model on an M-series Mac; the maintainer's test of the 560 ms int8 build gave 0.19 to 0.22. Not measured here: `pnpm bench:stt <file.wav>` prints the worker's own figure and its peak memory.

### Node

`process.stdout` is asynchronous when it is a pipe on POSIX (https://nodejs.org/api/process.html#a-note-on-process-io). Two consequences are built into the worker: a write can report a full pipe, which is when partials are dropped, and the process must let stdout drain before it exits or the last finals are lost.
