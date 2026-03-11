import { Component, ReactNode } from "react";

interface ErrorBoundaryProps {
  tabId: string;
  onClose: (tabId: string) => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  retryKey: number;
}

const btnStyle: React.CSSProperties = {
  padding: "6px 16px",
  background: "var(--surface, #313244)",
  border: "1px solid var(--overlay0, #6c7086)",
  borderRadius: "4px",
  color: "var(--text, #cdd6f4)",
  cursor: "pointer",
  fontSize: "13px",
  fontFamily: "inherit",
};

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, retryKey: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`Tab ${this.props.tabId} crashed:`, error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      retryKey: prev.retryKey + 1,
    }));
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: "12px",
          color: "var(--text, #cdd6f4)",
          fontFamily: "'Cascadia Code', 'Consolas', monospace",
          padding: "24px",
        }}>
          <div style={{ fontSize: "16px", fontWeight: "bold" }}>
            This tab crashed
          </div>
          <div style={{
            fontSize: "12px",
            color: "var(--subtext, #a6adc8)",
            maxWidth: "500px",
            textAlign: "center",
            wordBreak: "break-word",
          }}>
            {this.state.error?.message ?? "An unexpected error occurred."}
          </div>
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <button onClick={this.handleRetry} style={{ ...btnStyle, borderColor: "var(--accent, #cba6f7)" }}>
              Retry
            </button>
            <button onClick={() => this.props.onClose(this.props.tabId)} style={btnStyle}>
              Close Tab
            </button>
          </div>
        </div>
      );
    }

    // retryKey forces React to remount children on retry, giving a clean slate
    return <div key={this.state.retryKey} style={{ display: "contents" }}>{this.props.children}</div>;
  }
}
