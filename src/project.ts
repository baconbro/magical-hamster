/* Where the plugin lives, and the command that sets up its speech recognition. One place, so the
   settings, the sidebar and the README say the same thing.

   The plugin installs nothing itself (the Obsidian directory's policy): the user runs the setup
   once in Terminal. It downloads a script attached to the plugin's latest GitHub release and runs
   it with the user's own Node, which installs the speech library and model outside the vault. */

export const REPOSITORY = 'baconbro/magical-hamster';
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
export const SPEECH_SETUP_SCRIPT = 'setup-speech.mjs';
/** One line to paste into Terminal. */
export const SPEECH_SETUP_COMMAND = `curl -fsSL ${REPOSITORY_URL}/releases/latest/download/${SPEECH_SETUP_SCRIPT} -o ${SPEECH_SETUP_SCRIPT} && node ${SPEECH_SETUP_SCRIPT}`;
/** The README's section on it: what it downloads, where it goes, how to remove it. */
export const SPEECH_SETUP_HELP = `${REPOSITORY_URL}#speech-recognition`;
