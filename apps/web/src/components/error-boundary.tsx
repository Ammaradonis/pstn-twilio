import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('App error:', error, info.componentStack);
  }

  reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
          <div className="w-full max-w-md space-y-3 rounded border border-rose-200 bg-white p-6 shadow-sm">
            <h1 className="text-lg font-semibold text-rose-700">Something went wrong</h1>
            <p className="text-sm text-slate-700">
              The app caught an unexpected error and stopped rendering this view. The technical
              details are below for debugging.
            </p>
            <pre className="max-h-64 overflow-auto rounded bg-slate-900 p-3 text-[11px] text-slate-100">
              {this.state.error.message}
              {this.state.error.stack ? `\n\n${this.state.error.stack}` : ''}
            </pre>
            <div className="flex gap-2">
              <button
                onClick={this.reset}
                className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
              >
                Try again
              </button>
              <button
                onClick={() => {
                  window.location.href = '/dashboard';
                }}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm"
              >
                Reload dashboard
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
