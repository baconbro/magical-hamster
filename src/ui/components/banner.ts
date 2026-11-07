import type { RecordingState, Region, SttState, TabId } from '../../types.ts';

/* Which banners the header shows. Several things can be wrong at the same time,
   and none of them explains another: the setup (Ollama and its models), where
   Ollama runs, the recording (the microphone and the transcription) and the
   notes (the companion's markers, a section edited by hand, the cursor). Each
   has a line of its own. The session also raises a notice for a failed start
   and for a dead transcription, but a notice is gone after a few seconds: the
   banner is what still says it afterwards, and it must not wait behind an
   Ollama banner that can stay up for a whole session. Within a line the order
   is the priority. Pure, so it can be tested without rendering. */

export type SetupBanner = { kind: 'ollama-down' } | { kind: 'models-missing'; models: string[] };

/** Ollama is another computer: said for as long as it is, whatever else is on screen. */
export type RemoteBanner = { kind: 'ollama-remote'; message: string };

export type RecordingBanner =
  | { kind: 'stt-not-installed'; message: string }
  | { kind: 'stt-failed'; message: string }
  | { kind: 'recording-error'; message: string };

/**
 * `action` is the label of the button that reads the note again (`createCompanion`). That one
 * call looks at the markers again AND writes over the sections edited by hand, so when both
 * lines are up there is one button, on the second, and its label says both.
 */
export type NotesBanner =
  | { kind: 'detached'; message: string; action: string | null }
  | { kind: 'edited-outside'; message: string; action: string }
  | { kind: 'cursor-outside' };

export type BannerModel = SetupBanner | RemoteBanner | RecordingBanner | NotesBanner;

export interface BannerInputs {
  ollamaStatus: 'unknown' | 'ok' | 'unreachable';
  missingModels: string[];
  /** The host of the Ollama address when it is not this computer. */
  remoteHost: string | null;
  stt: SttState;
  sttMessage: string | null;
  tab: TabId;
  recording: RecordingState;
  hasTurns: boolean;
  recordingError: string | null;
  /** Regions of the companion whose markers are damaged: nothing is saved to them. */
  detachedRegions: readonly Region[];
  /** Regions of the companion whose text was edited by hand: the session no longer writes there. */
  editedOutside: readonly Region[];
  cursorOutside: boolean;
}

export const STT_NOT_INSTALLED_FALLBACK = 'Transcription is not installed on this Mac.';
export const STT_FAILED_FALLBACK = 'Transcription stopped. The recording continues without a transcript.';

/* What the companion calls its sections (the headings `notes/companion.ts` writes above each
   pair of markers), in the order of the note: the user knows them by these names, not by the
   words inside the markers. */
const SECTION_NAMES: ReadonlyArray<readonly [Region, string]> = [
  ['enhanced', 'Enhanced notes'],
  ['summary', 'AI summary'],
  ['qa', 'Q&A insights'],
  ['transcript', 'Transcript'],
];

function listed(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The sections those regions are, by name, in the order of the note, each once. */
function sectionNames(regions: readonly Region[]): string[] {
  return SECTION_NAMES.filter(([region]) => regions.includes(region)).map(([, name]) => name);
}

/** Names the sections of the companion whose markers are damaged, and says what that means for them. */
export function detachedMessage(regions: readonly Region[]): string {
  const names = sectionNames(regions);
  // A region this list does not know: still true, if less precise.
  if (names.length === 0) {
    return 'Markers were edited in the companion note. Nothing more is saved to their sections.';
  }
  const where = names.length === 1 ? 'that section' : 'those sections';
  return `The markers of ${listed(names)} were edited in the companion note. Nothing more is saved to ${where}.`;
}

/**
 * Names the sections of the companion whose text was edited by hand, and says what the session
 * does about them: it stops writing there, so the edit stays, until the note is read again on
 * request. From then on it saves there as before, starting with what the sidebar shows now.
 */
export function editedMessage(regions: readonly Region[]): string {
  const names = sectionNames(regions);
  const again = (edit: string): string => `Saving there again replaces ${edit} with what the sidebar shows.`;
  if (names.length === 0) {
    return `Text was edited by hand in the companion note, so nothing more is saved to its section. ${again('your edit')}`;
  }
  const many = names.length > 1;
  const where = many ? 'those sections' : 'that section';
  return `The text of ${listed(names)} was edited by hand in the companion note, so nothing more is saved to ${where}. ${again(many ? 'your edits' : 'your edit')}`;
}

/* The one thing the session offers for both lines: `createCompanion` on a note that exists
   reads it again, takes back the regions whose markers are whole, and saves what the sidebar
   shows to every region it writes to, the ones edited by hand included. */
export const CHECK_NOTE_ACTION = 'Check the note again';
export const SAVE_AGAIN_ACTION = 'Save there again';
export const CHECK_AND_SAVE_ACTION = 'Check and save there again';

/**
 * What to say when Ollama does not answer. "Start it" is advice for this computer: when the
 * address is another one, the line names it, or it would send the user to the wrong machine.
 */
export function ollamaDownMessage(remoteHost: string | null): string {
  const host = remoteHost?.trim() ?? '';
  return host === ''
    ? 'Ollama is not running. Start it, then retry.'
    : `Ollama does not answer on ${host}. Start it there, then retry.`;
}

/** Everything the plugin sends to Ollama is meeting content: said plainly when it leaves this computer. */
export function remoteMessage(host: string): string {
  return `Ollama runs on ${host}, not on this computer. Transcripts, notes and questions are sent there.`;
}

/** The session's message, or the fallback when it gave none: a blank one would draw an empty box. */
export function messageOr(message: string | null, fallback: string): string {
  return message !== null && message.trim() !== '' ? message : fallback;
}

function setupBanner(s: BannerInputs): SetupBanner | null {
  if (s.ollamaStatus === 'unreachable') return { kind: 'ollama-down' };
  if (s.missingModels.length > 0) return { kind: 'models-missing', models: s.missingModels };
  return null;
}

function recordingBanner(s: BannerInputs): RecordingBanner | null {
  if (s.stt === 'not-installed') {
    /* A permanent condition, so it only speaks up where a transcript is
       expected: while recording, or on the Transcript tab. The empty Transcript
       tab already shows the same message with the setup command; saying it
       twice on one screen helps nobody. */
    const transcriptTabSaysIt = s.tab === 'transcript' && !s.hasTurns;
    const expected = s.recording !== 'idle' || s.tab === 'transcript';
    if (expected && !transcriptTabSaysIt) {
      return { kind: 'stt-not-installed', message: messageOr(s.sttMessage, STT_NOT_INSTALLED_FALLBACK) };
    }
  }
  if (s.stt === 'failed') return { kind: 'stt-failed', message: messageOr(s.sttMessage, STT_FAILED_FALLBACK) };
  if (s.recordingError?.trim()) return { kind: 'recording-error', message: s.recordingError };
  return null;
}

function remoteBanner(s: BannerInputs): RemoteBanner | null {
  const host = s.remoteHost?.trim() ?? '';
  return host === '' ? null : { kind: 'ollama-remote', message: remoteMessage(host) };
}

function notesBanners(s: BannerInputs): NotesBanner[] {
  const detached = s.detachedRegions.length > 0;
  const edited = s.editedOutside.length > 0;
  const banners: NotesBanner[] = [];
  if (detached) {
    banners.push({ kind: 'detached', message: detachedMessage(s.detachedRegions), action: edited ? null : CHECK_NOTE_ACTION });
  }
  if (edited) {
    banners.push({
      kind: 'edited-outside',
      message: editedMessage(s.editedOutside),
      action: detached ? CHECK_AND_SAVE_ACTION : SAVE_AGAIN_ACTION,
    });
  }
  /* The hint about the cursor gives way to damaged markers, as it always did. Not to an edit by
     hand: that line stays up for as long as the user keeps the edit, which can be the rest of the
     meeting, and the hint would never be seen. */
  if (!detached && s.cursorOutside) banners.push({ kind: 'cursor-outside' });
  return banners;
}

/**
 * The banners to show, top to bottom: at most one about the setup, one when Ollama is another
 * computer, one about the recording, then the notes (damaged markers, a section edited by hand,
 * the cursor).
 */
export function pickBanners(s: BannerInputs): BannerModel[] {
  const banners: Array<BannerModel | null> = [setupBanner(s), remoteBanner(s), recordingBanner(s), ...notesBanners(s)];
  return banners.filter((banner): banner is BannerModel => banner !== null);
}
