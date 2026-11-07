/**
 * This build's identity, `magical-hamster-build:<uuid>`, in a development build (see vite.config.ts);
 * null in a release build. Absent under `node --test`.
 */
declare const __HAMSTER_BUILD__: string | null;
