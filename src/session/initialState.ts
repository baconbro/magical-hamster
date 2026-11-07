import type { DailyInfo, HamsterSettings, HamsterState, Stats } from '../types.ts';
import { remoteHostOf } from '../util/loopback.ts';

export function emptyStats(): Stats {
  return { input: 0, output: 0, cached: 0, weekly: {}, meetings: 0, assists: 0 };
}

/** The state before anything has happened. Pure, so the UI harness and the tests share it. */
export function initialState(settings: HamsterSettings, daily: DailyInfo): HamsterState {
  return {
    ollama: { status: 'unknown', missingModels: [], remoteHost: remoteHostOf(settings.ollamaUrl) },
    daily,
    sections: [],
    activeSection: null,
    meeting: null,
    shorthand: [],

    recording: 'idle',
    recordingError: null,
    elapsedMs: 0,
    micLevel: 0,
    stt: 'idle',
    sttMessage: null,
    turns: [],
    partial: null,

    liveEnhance: settings.liveEnhanceDefault,
    enhanceStyle: settings.enhanceStyle,
    enhanceStatus: 'idle',
    enhanceError: null,
    enhanced: [],

    summary: { style: settings.summaryStyle, status: 'idle', markdown: '', error: null },
    qa: { entries: [], chips: [] },

    stats: emptyStats(),
    lastUsage: null,
    index: {
      status: 'none',
      files: 0,
      chunks: 0,
      done: 0,
      total: 0,
      folders: settings.indexedFolders,
      error: null,
    },

    tab: 'meetings',
    focusedNote: null,
    pendingWrites: 0,
    micLabel: settings.micLabel,
    costPer1k: settings.costPer1k,
    companionFolder: settings.companionFolder,
  };
}
