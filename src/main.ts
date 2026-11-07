import { join } from 'node:path';
import { MarkdownView, Plugin, TFile, normalizePath } from 'obsidian';
import type { Events, WorkspaceLeaf } from 'obsidian';
import { DailyNoteLocator } from './editor/dailyNote.ts';
import { liveCaptureExtension } from './editor/liveCapture.ts';
import { loadLocal, saveLocal } from './host/localSettings.ts';
import { createCallLog, withCallLog, type CallLogWriter } from './llm/callLog.ts';
import { createNotesHost } from './host/notesHost.ts';
import { showNotice } from './host/notice.ts';
import { reloadBlocker, reloadPlugin, startSelfReload } from './host/selfReload.ts';
import { defaultRuntimeDir, readRuntime, resolveNodePath, resolveRuntimeDir } from './host/runtime.ts';
import { createStatsIO } from './host/statsIO.ts';
import { createVaultIndexIO } from './host/vaultIndexIO.ts';
import { createOllamaClient } from './llm/ollama.ts';
import { CompanionStore } from './notes/companionStore.ts';
import { TextTarget, bufferFileField } from './notes/textTarget.ts';
import { speechSetupCommand } from './project.ts';
import { createSession } from './session/meetingSession.ts';
import { DEFAULT_LOCAL, DEFAULT_SETTINGS, PLUGIN_ID, VIEW_TYPE, parseSettings } from './settings.ts';
import { HamsterSettingTab, checkSoftMarkerPattern } from './settings-tab.ts';
import { createNodeTranscriptSource } from './stt/nodeSttSource.ts';
import type { Clock, HamsterSession, HamsterSettings, LocalSettings, UiHost } from './types.ts';
import { HamsterView } from './ui/SidebarView.ts';
import { renderMiniMarkdown } from './ui/miniMarkdown.ts';
import { syncAllThemes } from './ui/mount.tsx';
import { remoteHostWarning } from './util/loopback.ts';


const DATE_CHECK_MS = 60_000;
const QUIT_FLUSH_MS = 3000;
const EDITOR_SECOND_LOOK_MS = 150;
const REMOTE_OLLAMA_NOTICE_MS = 15_000;
const RELOAD_NOTICE_MS = 10_000;
const PATTERN_NOTICE_MS = 15_000;
// A soft-marker pattern that matches no line.
const NO_SOFT_MARKER = '$^';
/* The last soft-marker pattern found usable on this device (vault-scoped
   localStorage, like the device settings). The number goes up when the check
   learns something, so that every stored pattern is looked at again. */
const CHECKED_PATTERN_KEY = 'magical-hamster:soft-marker-checked-2';

/* `window` timers on purpose: with Node integration the bare globals can be
   Node's, whose handles are objects rather than numbers. */
const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (handle) => window.clearInterval(handle as number),
};

export default class MagicalHamsterPlugin extends Plugin {
  settings: HamsterSettings = DEFAULT_SETTINGS;
  private local: LocalSettings = DEFAULT_LOCAL;
  /** Every exchange with the model while the Debug tab is on; in memory only. */
  private callLog: CallLogWriter | null = null;
  private session: HamsterSession | null = null;
  private unloaded = false;
  /* `settings` as the session may use it: see `usableSettings`. Kept per settings object and per pattern. */
  private usable: { from: HamsterSettings; settings: HamsterSettings } | null = null;
  private checkedPattern: { source: string; refused: boolean } | null = null;

  /* Wiring only. Nothing here writes to the vault: the first write happens
     when the user clicks Create companion. */
  async onload(): Promise<void> {
    const { app } = this;
    const { vault, workspace } = app;
    const stored: unknown = await this.loadData();
    this.settings = parseSettings(stored);
    this.local = loadLocal(app);
    /* Obsidian answers null for a data.json it cannot parse, as for none at
       all. The defaults are then in use, and the next change of a setting
       would write over the file: said once, so that a hand edit or a sync
       conflict can be put right first. */
    if (stored === null && (await this.dataFileExists())) {
      showNotice(
        'The settings file (data.json in the plugin folder) could not be read, so the defaults are in use. Fix or delete it before changing a setting, or the next change writes over it.',
        0,
      );
    }

    const locator = new DailyNoteLocator(app);
    await locator.load();
    /* Disabled again while those reads were on their way. Obsidian has run its
       cleanup already: whatever registered itself from here on would stay for
       good, and the view type would refuse the next start. */
    if (this.unloaded) return;

    // Path -> time of the last change in an editor, by anyone. Guards Vault writes.
    const touches = new Map<string, number>();
    const target = new TextTarget(app, {
      lastTouch: (path) => touches.get(path),
      now: () => Date.now(),
    });
    const companions = new CompanionStore(app, () => this.settings, target);
    const notes = createNotesHost(app, {
      settings: () => this.usableSettings(),
      locator,
      target,
      companions,
    });
    /* The folder the setting stands for: the default when empty, the home
       directory for a leading `~`, a relative folder taken from home. Resolved
       here and nowhere else, so that the speech source, the stats file, the
       index and the settings tab agree. The Node path is expanded the same way:
       a `~` spawned as typed is a relative path that exists nowhere. */
    const runtimeDir = (): string => resolveRuntimeDir(this.local.runtimeDir);
    const local = (): LocalSettings => ({
      ...this.local,
      runtimeDir: runtimeDir(),
      nodePath: resolveNodePath(this.local.nodePath),
    });
    /* Where the stats and the index are read and written until Obsidian starts
       again. The session loads both once, at start: following the setting
       while it is typed would create a folder for each character, and would
       then write what was loaded from the old folder over what the new one holds. */
    const ioDir = runtimeDir();
    /* The plugin's own version: the setup command names its release, so that
       the worker installed is the one this build was made with, and a runtime
       set up by another major.minor is pointed out. The manifest is Obsidian's
       to give; the tests' stub may give none. */
    const pluginVersion = this.manifest?.version ?? null;
    const setupCommand = speechSetupCommand(pluginVersion);

    const callLog = createCallLog({ clock, enabled: this.local.debugTab });
    this.callLog = callLog;
    const session = createSession({
      settings: () => this.usableSettings(),
      updateSettings: (patch) => this.updateSettings(patch),
      local,
      setLocal: (patch) => this.setLocal(patch),
      notes,
      llm: withCallLog(createOllamaClient({ baseUrl: () => this.settings.ollamaUrl, clock }), callLog),
      createTranscriptSource: () =>
        createNodeTranscriptSource({
          clock,
          // The source takes the paths as they are written: it gets the resolved ones.
          local,
          language: () => this.settings.sttLanguage,
          pluginVersion: pluginVersion ?? undefined,
        }),
      vaultIndexIO: createVaultIndexIO(app, () => ioDir),
      statsIO: createStatsIO(() => ioDir),
      clock,
      clipboard: (text) => {
        navigator.clipboard.writeText(text).catch((error: unknown) => {
          console.error('Magical Hamster: could not copy', error);
        });
      },
    });
    this.session = session;
    this.watchOwnBuild(session);

    /* The sidebar draws model text with the plugin's own renderer, never with
       Obsidian's: that one hands its output to every plugin's post-processor
       (Dataview runs a `dataviewjs` block) and fetches images and raw tags as
       it draws them. See src/ui/miniMarkdown.ts. */
    const host: UiHost = { renderMarkdown: renderMiniMarkdown, callLog, speechSetupCommand: setupCommand };
    this.registerView(
      VIEW_TYPE,
      (leaf: WorkspaceLeaf) =>
        new HamsterView(leaf, () => ({ store: session.store, controller: session.controller, host })),
    );

    // Lets the write router tell whose text an editor holds while its view changes note.
    this.registerEditorExtension(bufferFileField);
    this.registerEditorExtension(
      liveCaptureExtension({
        isDaily: (path) => path === locator.today().path,
        onTouch: (path) => touches.set(path, Date.now()),
        /* With the daily in several panes, Obsidian copies every change into
           each of them and each one reports it, with a cursor of its own. The
           cursor that counts is in the pane last used. */
        onDaily: (update) =>
          session.handleDailyUpdate({ ...update, cursor: target.cursor(update.path) ?? update.cursor }),
        // The note in front, and the one a meeting is typed in: every other note is ignored.
        wantsNote: (path) => path === focusedPath || path === session.store.getState().meeting?.notePath,
        onNote: (update) =>
          session.handleNoteUpdate({ ...update, cursor: target.cursor(update.path) ?? update.cursor }),
      }),
    );

    /* The note in front of the user: the Markdown note of the main area last used. Clicking the
       sidebar makes the sidebar the active leaf, so the main area's own most recent leaf is the one
       that counts. */
    let focusedPath: string | null = null;
    const lookAtFocus = (): void => {
      const view = workspace.getMostRecentLeaf()?.view;
      if (!(view instanceof MarkdownView) || !view.file) return;
      const path = view.file.path;
      focusedPath = path;
      if (path === locator.today().path) {
        session.handleFocus({ path, text: null, cursor: null });
        return;
      }
      const editor = view.editor;
      const source = view.getMode() === 'source';
      session.handleFocus({
        path,
        text: editor.getValue(),
        cursor: source ? editor.posToOffset(editor.getCursor('head')) : null,
      });
    };

    /* Today's daily as its editor has it, cursor included. False when it is
       not open in source mode. */
    const pushFromEditor = (): boolean => {
      const { path } = locator.today();
      const open = target.openEditor(path);
      if (!open) return false;
      session.handleDailyUpdate({
        path,
        text: open.editor.getValue(),
        cursor: open.editor.posToOffset(open.editor.getCursor('head')),
        userTyped: false,
      });
      return true;
    };
    const pushDaily = async (): Promise<void> => {
      if (pushFromEditor()) return;
      const { path } = locator.today();
      const text = await target.read(path);
      if (text !== null) session.handleDailyUpdate({ path, text, cursor: null, userTyped: false });
    };
    const readDaily = (): void => {
      pushDaily().catch((error: unknown) => {
        console.error('Magical Hamster: could not read the daily note', error);
      });
    };
    /* The daily appeared, went away or became another note. The session reads
       it again by itself; only an editor can add where the cursor is. */
    const refreshDaily = (): void => {
      session.handleDailyAvailability();
      pushFromEditor();
    };

    const activate = (): void => this.openSidebar();
    /* A command used with no meeting selected says so and shows where to pick one. */
    const withMeeting = (run: () => void) => (): void => {
      if (session.store.getState().meeting) {
        run();
        return;
      }
      notes.notice('Pick a meeting in the sidebar first.');
      activate();
    };

    this.addRibbonIcon('audio-lines', 'Open Magical Hamster', activate);
    this.addCommand({ id: 'open', name: 'Open sidebar', callback: activate });
    /* Offered only with a note in front that can hold a meeting: the rule the sidebar's buttons
       follow (NoteChoice). The session tracks that note itself: Obsidian's active view is the
       sidebar while it has the focus. */
    const noteInFront = (): boolean => {
      const focused = session.store.getState().focusedNote;
      return focused !== null && !focused.daily;
    };
    this.addCommand({
      id: 'use-this-note',
      name: 'Use the open note for the meeting',
      checkCallback: (checking) => {
        if (!noteInFront()) return false;
        if (!checking) void session.controller.useActiveNote();
        return true;
      },
    });
    this.addCommand({
      id: 'write-meeting-into-note',
      name: 'Write the meeting into the open note',
      checkCallback: (checking) => {
        if (!noteInFront()) return false;
        if (!checking) void session.controller.writeIntoActiveNote();
        return true;
      },
    });
    this.addCommand({
      id: 'toggle-debug-tab',
      name: 'Show or hide the model exchange log',
      callback: () => {
        const on = !this.local.debugTab;
        this.setLocal({ debugTab: on });
        showNotice(on ? 'Debug tab shown: exchanges with the model are kept in memory.' : 'Debug tab hidden; its log is cleared.');
      },
    });
    this.addCommand({
      id: 'toggle-recording',
      name: 'Start or stop recording',
      callback: withMeeting(() => {
        const { recording } = session.store.getState();
        if (recording === 'recording') void session.controller.stopRecording();
        else if (recording === 'idle') void session.controller.startRecording();
      }),
    });
    this.addCommand({
      id: 'new-meeting',
      name: 'New meeting',
      callback: () => {
        session.controller.newMeeting();
        activate();
      },
    });
    this.addCommand({
      id: 'create-companion',
      name: 'Create companion note',
      callback: withMeeting(() => void session.controller.createCompanion()),
    });
    this.addCommand({
      id: 'enhance-now',
      name: 'Enhance notes now',
      callback: withMeeting(() => void session.controller.enhanceNow()),
    });

    this.addSettingTab(
      new HamsterSettingTab(app, this, {
        settings: () => this.settings,
        updateSettings: (patch) => this.updateSettings(patch),
        local: () => this.local,
        setLocal: (patch) => this.setLocal(patch),
        defaultRuntimeDir,
        runtimeDir,
        readRuntime,
        speechSetupCommand: setupCommand,
        pluginVersion,
      }),
    );

    this.registerEvent(workspace.on('css-change', () => syncAllThemes()));
    /* The only shutdown hook Obsidian waits for. Obsidian saves its editors
       before this runs, so what the session then writes into an open companion
       is saved here. A task that rejected would leave the window on "Saving...". */
    const saveEditors = (): Promise<void> => target.saveEditors();
    this.registerEvent(
      workspace.on('quit', (tasks) => {
        tasks.add(() =>
          session
            .flushAll(QUIT_FLUSH_MS)
            .then(() => session.dispose())
            .then(saveEditors, saveEditors),
        );
      }),
    );
    /* The editor binding only speaks when something changes; opening the daily
       changes nothing. A view that is still reading the file gets a second look. */
    const lookAtEditor = (): void => {
      if (!pushFromEditor()) window.setTimeout(pushFromEditor, EDITOR_SECOND_LOOK_MS);
    };
    this.registerEvent(workspace.on('file-open', lookAtEditor));
    this.registerEvent(workspace.on('active-leaf-change', lookAtEditor));
    this.registerEvent(workspace.on('file-open', lookAtFocus));
    this.registerEvent(workspace.on('active-leaf-change', lookAtFocus));
    workspace.onLayoutReady(lookAtFocus);

    this.registerEvent(
      vault.on('modify', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        if (file.path !== locator.today().path) {
          session.handleVaultChange({ type: 'modify', path: file.path });
          return;
        }
        // Open in an editor, the binding has reported the change already, as typed.
        if (!target.openEditor(file.path)) readDaily();
      }),
    );
    this.registerEvent(
      vault.on('create', (file) => {
        // While the vault loads, Obsidian announces every existing file this way.
        if (!workspace.layoutReady) return;
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        companions.refresh(file.path);
        if (file.path === locator.today().path) refreshDaily();
        else session.handleVaultChange({ type: 'modify', path: file.path });
      }),
    );
    this.registerEvent(
      vault.on('delete', (file) => {
        touches.delete(file.path);
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        companions.forget(file.path);
        if (file.path === locator.today().path) session.handleDailyAvailability();
        session.handleVaultChange({ type: 'delete', path: file.path });
      }),
    );
    this.registerEvent(
      vault.on('rename', (file, oldPath) => {
        const stamp = touches.get(oldPath);
        touches.delete(oldPath);
        if (stamp !== undefined) touches.set(file.path, stamp);
        if (!(file instanceof TFile)) return;

        const wasNote = /\.md$/i.test(oldPath);
        const isNote = file.extension === 'md';
        if (!wasNote && !isNote) return;
        companions.renamed(oldPath, file.path);
        const daily = locator.today().path;
        if (file.path === daily || oldPath === daily) refreshDaily();
        if (wasNote && isNote) session.handleVaultChange({ type: 'rename', path: file.path, oldPath });
        else if (wasNote) session.handleVaultChange({ type: 'delete', path: oldPath });
        else session.handleVaultChange({ type: 'modify', path: file.path });
      }),
    );

    this.registerEvent(app.metadataCache.on('changed', (file) => companions.refresh(file.path)));
    /* At start-up the metadata cache can still be reading the vault when the
       session first looks for companions. Once it has caught up, look again. */
    const caughtUp = app.metadataCache.on('resolved', () => {
      app.metadataCache.offref(caughtUp);
      companions.refresh();
      refreshDaily();
    });
    this.registerEvent(caughtUp);

    /* `raw` is how Obsidian itself watches its config files; the public typings
       leave it out. Without it, the interval below still picks a change up. */
    const dailyConfig = new Set(locator.configPaths());
    const reloadDailyConfig = (): void => {
      locator.load().then(refreshDaily, (error: unknown) => {
        console.error('Magical Hamster: could not read the daily notes settings', error);
      });
    };
    this.registerEvent(
      (vault as Events).on('raw', (path) => {
        if (typeof path === 'string' && dailyConfig.has(path)) reloadDailyConfig();
      }),
    );

    // Best effort: the quit task above is the one Obsidian waits for.
    this.registerDomEvent(window, 'beforeunload', () => void session.dispose());
    // At midnight today's daily becomes another note; nothing announces it.
    this.registerInterval(window.setInterval(reloadDailyConfig, DATE_CHECK_MS));

    workspace.onLayoutReady(() => {
      void session.init().then(() => {
        // `init` reads the note; only its editor knows where the cursor is.
        pushFromEditor();
      });
      // Said at every start: the address may have arrived by sync while Obsidian was closed.
      this.warnOfRemoteOllama('start');
    });
  }

  onunload(): void {
    this.unloaded = true;
    // Not awaited by Obsidian: the session stops the speech worker and flushes what it can.
    void this.session?.dispose();
    this.session = null;
  }

  /**
   * A development build (one with `.selfreload` beside it) loads the next build by itself once
   * `pnpm install:plugin` has copied it: see src/host/selfReload.ts.
   */
  private watchOwnBuild(session: HamsterSession): void {
    const base = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
    const folder = this.manifest?.dir;
    // Null in a release build; absent where the code was not built by vite.config.ts (the tests).
    const buildId = typeof __HAMSTER_BUILD__ === 'string' ? __HAMSTER_BUILD__ : null;
    if (!base || !folder || !buildId) return;
    let watcher: { dispose(): void } | null = null;
    try {
      watcher = startSelfReload({
        dir: join(base, folder),
        buildId,
        blocker: () => reloadBlocker(session.store.getState()),
        subscribe: (listener) => session.store.subscribe(listener),
        notify: (message) => showNotice(message, RELOAD_NOTICE_MS),
        reload: () =>
          reloadPlugin({
            app: this.app,
            id: this.manifest.id,
            viewType: VIEW_TYPE,
            notify: (message) => showNotice(message),
            // Everything written first; the unload then finds the session already closed.
            closeSession: () => session.dispose(),
          }),
      });
    } catch (error) {
      // A folder that cannot be watched only means reloading by hand, as without this.
      console.error('Magical Hamster: could not watch for a new build', error);
    }
    if (watcher) this.register(() => watcher.dispose());
  }

  /** The first time the user turns the plugin on, show them where it lives. */
  onUserEnable(): void {
    this.openSidebar();
  }

  /* Only ever called from a user action: before the layout is ready
     `ensureSideLeaf` can throw. */
  private openSidebar(): void {
    const open = async (): Promise<void> => {
      await this.app.workspace.ensureSideLeaf(VIEW_TYPE, 'right', { reveal: true });
    };
    open().catch((error: unknown) => {
      console.error('Magical Hamster: could not open the sidebar', error);
    });
  }

  /** data.json changed on disk: another device synced its settings. */
  async onExternalSettingsChange(): Promise<void> {
    const previous = this.settings.ollamaUrl;
    this.settings = parseSettings(await this.loadData());
    this.session?.handleSettingsChange();
    // Nobody at this computer chose the new address: it is said, and stays said until it is read.
    if (this.settings.ollamaUrl !== previous) this.warnOfRemoteOllama('synced');
  }

  /** Whether the plugin's data.json is on disk, whatever it holds. */
  private async dataFileExists(): Promise<boolean> {
    const { vault } = this.app;
    const path = normalizePath(`${vault.configDir}/plugins/${this.manifest?.id ?? PLUGIN_ID}/data.json`);
    try {
      return await vault.adapter.exists(path);
    } catch {
      return false;
    }
  }

  private async updateSettings(patch: Partial<HamsterSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    try {
      await this.saveData(this.settings);
    } finally {
      // In memory the change is already in effect, saved or not.
      this.session?.handleSettingsChange();
    }
  }

  /**
   * The settings as the session and the notes host may use them. The pattern
   * for meeting lines without a heading runs on every line of the daily note
   * at every keystroke. The settings tab refuses one that would freeze typing,
   * but data.json also changes by sync and by hand: a pattern the tab would
   * refuse is replaced here by one that matches nothing, and the user is told.
   */
  private usableSettings(): HamsterSettings {
    const from = this.settings;
    if (this.usable?.from === from) return this.usable.settings;
    const settings = this.patternRefused(from.softMarkerPattern)
      ? { ...from, softMarkerPattern: NO_SOFT_MARKER }
      : from;
    this.usable = { from, settings };
    return settings;
  }

  private patternRefused(source: string): boolean {
    // The pattern the plugin ships with needs no checking at every start.
    if (source === DEFAULT_SETTINGS.softMarkerPattern || source === NO_SOFT_MARKER) return false;
    if (this.checkedPattern?.source === source) return this.checkedPattern.refused;
    /* Nor does the one this device has already checked: the check takes some
       tens of milliseconds. A hand-edited data.json can hold anything where
       the pattern should be: only text is looked at. */
    const refused =
      typeof (source as unknown) !== 'string' ||
      (this.app.loadLocalStorage(CHECKED_PATTERN_KEY) !== source && checkSoftMarkerPattern(source) !== null);
    this.checkedPattern = { source, refused };
    if (refused) {
      showNotice(
        'The pattern for meeting lines without a heading is empty, invalid or too slow, and is not used. Change it in the settings.',
        PATTERN_NOTICE_MS,
      );
    } else {
      this.app.saveLocalStorage(CHECKED_PATTERN_KEY, source);
    }
    return refused;
  }

  /** Says where the text of a meeting goes when the Ollama address is not this computer. */
  private warnOfRemoteOllama(why: 'start' | 'synced'): void {
    const warning = remoteHostWarning(this.settings.ollamaUrl);
    if (warning === null) return;
    if (why === 'synced') {
      showNotice(
        `The Ollama address changed with the settings synced from another device. ${warning} Change the address in the settings if that is not what you want.`,
        0,
      );
      return;
    }
    showNotice(`${warning} The Ollama address is in the settings.`, REMOTE_OLLAMA_NOTICE_MS);
  }

  private setLocal(patch: Partial<LocalSettings>): void {
    this.local = { ...this.local, ...patch };
    saveLocal(this.app, this.local);
    this.callLog?.setEnabled(this.local.debugTab);
  }
}
