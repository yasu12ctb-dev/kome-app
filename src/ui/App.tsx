import { useEffect, useState, type ReactNode } from 'react';
import { requestAppUpdate } from '../app/autoUpdate';
import { appReloadCoordinator, type ReloadCoordinator } from '../app/reload';
import type { RestorePreview } from '../backup/service';
import { AddEdit } from './AddEdit';
import { ConflictDialog, RestoreDialog } from './Dialogs';
import { Home } from './Home';
import { Records } from './Records';
import { Settings } from './Settings';
import { Stats } from './Stats';
import { APP_VERSION, useKome } from './useKome';

// 画面の切り替えは URL の # で行う（ホーム画面版でも戻るリンクで移動できる）

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash.replace(/^#/, ''));
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash.replace(/^#/, ''));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function go(hash: string) {
  window.location.hash = hash;
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function App(props: { coordinator?: ReloadCoordinator } = {}) {
  const [coordinator] = useState(() => props.coordinator ?? appReloadCoordinator());
  const { state, actions } = useKome(coordinator);
  const hash = useHash();
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [conflict, setConflict] = useState(false);

  if (state.kind === 'loading') return <main className="screen" data-screen="loading" aria-busy="true" />;
  if (state.kind === 'stopped') {
    const message =
      state.reason === 'open-failed'
        ? 'データを開けませんでした。アプリを開き直してください。'
        : '新しい版のアプリで作られたデータです。アプリを更新してください。';
    return (
      <main className="screen" data-screen="stopped">
        <div style={{ height: 44 }} />
        <h1 style={{ fontSize: 30, fontWeight: 900, lineHeight: 1.35 }}>{message}</h1>
        <p className="sub">記録には触れていません。</p>
        <div className="home-foot">
          <button
            type="button"
            className="primary"
            onClick={async () => {
              await requestAppUpdate(window);
              // 停止画面には入力を持つ画面が無く、利用者の明示の操作なので窓口を通さない（§6.2）
              window.location.reload();
            }}
          >
            更新して開き直す
          </button>
        </div>
      </main>
    );
  }

  const { receipts, meta, lineage, hasSnapshot, today } = state;
  const lastKg = receipts.at(-1)?.kg ?? null;
  let screen: ReactNode;
  if (hash === 'add') {
    screen = <AddEdit key="add" today={today} editing={null} lastKg={lastKg} onSave={actions.add} onDelete={actions.remove} onDone={() => go('')} />;
  } else if (hash.startsWith('edit/')) {
    const id = hash.slice(5);
    const r = receipts.find((x) => x.id === id) ?? null;
    screen = r ? (
      <AddEdit key={id} today={today} editing={r} lastKg={lastKg} onSave={(input) => actions.update(id, input)} onDelete={actions.remove} onDone={() => go('records')} />
    ) : (
      <Records receipts={receipts} onlyUnpaid={false} />
    );
  } else if (hash.startsWith('records')) {
    screen = <Records receipts={receipts} onlyUnpaid={hash.includes('unpaid')} />;
  } else if (hash === 'stats') {
    screen = <Stats receipts={receipts} today={today} />;
  } else if (hash === 'settings') {
    screen = (
      <Settings
        receipts={receipts}
        purchase={state.purchase}
        lineage={lineage}
        dataRevision={meta.dataRevision}
        deviceId={meta.deviceId}
        hasSnapshot={hasSnapshot}
        today={today}
        version={APP_VERSION}
        actions={actions}
        onPreview={setPreview}
        onConflict={() => setConflict(true)}
      />
    );
  } else {
    screen = <Home receipts={receipts} purchase={state.purchase} lineage={lineage} dataRevision={meta.dataRevision} today={today} standalone={isStandalone()} onConflict={() => setConflict(true)} />;
  }

  return (
    <>
      {state.upgrading && (
        <div className="banner" role="status" style={{ margin: 0, position: 'sticky', top: 0, zIndex: 20 }}>
          新しい版のアプリが別の画面で開かれました。入力を終えると読み込み直します（今は保存できません）。
        </div>
      )}
      {screen}
      {conflict && !preview && (
        <ConflictDialog
          onOverwrite={async () => {
            await actions.overwriteRemote();
            setConflict(false);
          }}
          onRestore={async () => {
            const r = await actions.previewFromGitHub();
            if (r.kind === 'ok') setPreview(r.preview);
            setConflict(false);
            if (r.kind !== 'ok') go('settings');
          }}
          onClose={() => setConflict(false)}
        />
      )}
      {preview && (
        <RestoreDialog
          preview={preview}
          onConfirm={async () => {
            const r = await actions.confirmRestore(preview);
            if (r.kind === 'ok') go('');
            return r.kind;
          }}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
