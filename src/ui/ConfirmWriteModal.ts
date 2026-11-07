import { ButtonComponent, Modal } from 'obsidian';
import type { App } from 'obsidian';
import type { FirstWritePreview } from '../types.ts';
import { confirmWriteText } from './components/format.ts';

/**
 * Shown before the plugin writes to a vault for the first time: exactly what
 * will be created and what will be added, before any of it happens.
 */
class ConfirmWriteModal extends Modal {
  private readonly preview: FirstWritePreview;
  private readonly done: (accepted: boolean) => void;
  private accepted = false;

  constructor(app: App, preview: FirstWritePreview, done: (accepted: boolean) => void) {
    super(app);
    this.preview = preview;
    this.done = done;
  }

  onOpen(): void {
    const { contentEl, preview } = this;
    const text = confirmWriteText(preview);
    this.setTitle(text.title);
    contentEl.empty();
    contentEl.createEl('p', { text: text.intro });
    // Shown character for character: the line is what lands in the user's own note.
    for (const row of text.rows) {
      if (row.code) this.row(row.label).createEl('code', { text: row.value });
      else this.row(row.label).setText(row.value);
    }

    const buttons = contentEl.createDiv('modal-button-container');
    // Cancel comes first: if a button takes the focus when the dialog opens, it is the harmless one.
    new ButtonComponent(buttons).setButtonText('Cancel').onClick(() => this.close());
    new ButtonComponent(buttons)
      .setButtonText(text.button)
      .setCta()
      .onClick(() => {
        this.accepted = true;
        this.close();
      });
  }

  onClose(): void {
    // Also reached by Escape, the close button and a click outside: all of them mean no.
    this.contentEl.empty();
    this.done(this.accepted);
  }

  private row(label: string): HTMLElement {
    const row = this.contentEl.createDiv();
    row.setCssStyles({ marginBottom: 'var(--size-4-3)' });
    row.createDiv({ cls: 'setting-item-description', text: label });
    const value = row.createDiv();
    value.setCssStyles({ overflowWrap: 'anywhere', userSelect: 'text' });
    return value;
  }
}

/** Shows the first-write confirmation. Resolves true only when the user chose Create. */
export function confirmWrite(app: App, preview: FirstWritePreview): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmWriteModal(app, preview, resolve).open();
  });
}
