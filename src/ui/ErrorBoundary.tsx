import { Component, type ErrorInfo, type ReactNode } from 'react';

// 描画中の思わぬ例外で画面が真っ白にならないようにする安全網。記録には触れない

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('kome: 画面を表示できませんでした', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="screen">
        <div style={{ height: 44 }} />
        <h1 style={{ fontSize: 28, fontWeight: 900, lineHeight: 1.35 }}>画面を表示できませんでした</h1>
        <p className="sub" style={{ lineHeight: 1.7 }}>記録には触れていません。開き直してください。続くときは、この画面を撮って知らせてください。</p>
        <p className="sub" style={{ fontSize: 12, wordBreak: 'break-all' }}>{this.state.error.message}</p>
        <div className="home-foot">
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            開き直す
          </button>
        </div>
      </main>
    );
  }
}
