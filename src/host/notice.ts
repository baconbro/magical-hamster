import { Notice } from 'obsidian';

/* Every notice the plugin shows starts with its name, so that the user knows
   who is talking among the notices of other plugins. One place to add it:
   a message written elsewhere never carries the name itself. */
export const NOTICE_PREFIX = 'Magical Hamster: ';

/** Shows `message` with the plugin's name in front; `ms` as Obsidian's Notice takes it (0 keeps it up). */
export function showNotice(message: string, ms?: number): Notice {
  return new Notice(NOTICE_PREFIX + message, ms);
}
