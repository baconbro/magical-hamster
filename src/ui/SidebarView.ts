import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE } from '../settings.ts';
import { mountHamster } from './mount.tsx';
import type { AppProps } from './context.tsx';
import { watchBottomInset } from './inset.ts';

/** The right-sidebar leaf. All it does is host the React tree. */
export class HamsterView extends ItemView {
  private unmount: (() => void) | null = null;
  private unwatch: (() => void) | null = null;
  private readonly getProps: () => AppProps;

  constructor(leaf: WorkspaceLeaf, getProps: () => AppProps) {
    super(leaf);
    this.getProps = getProps;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Magical Hamster';
  }

  getIcon(): string {
    return 'audio-lines';
  }

  protected async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.classList.add('mh-view');
    this.unmount = mountHamster(this.contentEl, this.getProps());
    this.unwatch = watchBottomInset(this.contentEl);
    // A pane moved or a sidebar resized does not always resize this view's own box.
    this.registerEvent(this.app.workspace.on('layout-change', () => this.remeasure()));
  }

  private remeasure(): void {
    this.unwatch?.();
    this.unwatch = this.contentEl.isConnected ? watchBottomInset(this.contentEl) : null;
  }

  protected async onClose(): Promise<void> {
    this.unwatch?.();
    this.unwatch = null;
    this.unmount?.();
    this.unmount = null;
    this.contentEl.classList.remove('mh-view');
  }
}
