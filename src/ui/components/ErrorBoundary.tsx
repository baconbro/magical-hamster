import { CircleAlert } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorMessageOf } from './errorText.ts';
import { Button } from './ui.tsx';

interface Props {
  children: ReactNode;
  /** What the boundary stands in for, as the message names it: "The sidebar", "The Notes tab". */
  label?: string;
}

type State = { failed: false } | { failed: true; error: unknown };

/**
 * Keeps a render that throws from taking the whole sidebar down. Caught by nothing, such an error
 * makes React unmount the root, and the leaf stays blank until it is closed and opened again. The
 * session and the vault writes run outside React and go on either way, so there is something to
 * come back to: the fallback says what happened and offers to draw the children again, afresh. A
 * class, because React has no hook for this.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Tagged, to be found among Obsidian's own console output; with the component stack, which the message lacks.
    console.error('[magical-hamster]', error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ failed: false });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { label = 'The sidebar' } = this.props;
    return (
      /* Drawn like a danger line of the Banner, with the same tokens, so it reads as the plugin's. */
      <div
        role="alert"
        className="m-3 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 p-2 text-xs leading-snug text-ink"
      >
        <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0 text-danger" />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
          <p className="break-words">
            {label} hit an error: {errorMessageOf(this.state.error)}
          </p>
          <Button onClick={this.reset}>Reload view</Button>
        </div>
      </div>
    );
  }
}
