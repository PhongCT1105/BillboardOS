import { Component, type ErrorInfo, type ReactNode } from "react";

type State = { error: Error | null };

/**
 * One failing query or component must not blank the whole app.
 * Shows what broke and offers a reload instead of an empty black page.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("BillboardOS crashed while rendering", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A client built before the latest backend deploy shows up as argument/return validation errors.
    const stale = /ArgumentValidationError|ReturnsValidationError|Could not find public function/i.test(error.message);
    return (
      <main className="grid min-h-[100dvh] place-items-center px-4">
        <section className="w-full max-w-md rounded-xl border border-line bg-panel p-8">
          <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted">
            {stale
              ? "This page is out of date with the server. Reload to get the latest version."
              : "The page hit an error. Reloading usually fixes it."}
          </p>
          <pre className="mt-4 max-h-32 overflow-auto rounded-md bg-ink p-3 font-mono text-xs text-faint">{error.message}</pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-6 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-transform active:scale-[0.98]"
          >
            Reload
          </button>
        </section>
      </main>
    );
  }
}
