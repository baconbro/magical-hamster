/* The harness never loads the Obsidian adapters, so nothing should import
   `obsidian` at run time here. This stub exists so that a stray import fails
   loudly in the console instead of breaking the dev server's resolution. */

const refuse = (name: string) => () => {
  throw new Error(`obsidian.${name} is not available in the browser harness`);
};

export class Plugin {}
export class ItemView {}
export class Modal {}
export class PluginSettingTab {}
export class Setting {}
/* The harness shows the plugin's notices as toasts, through its fake notes host (realSession.ts). */
export class Notice {}
export const MarkdownRenderer = { render: refuse('MarkdownRenderer.render') };
export const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/');
