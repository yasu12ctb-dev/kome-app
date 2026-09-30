# Kome-app 設計書: 米の受取記録・予測・GitHub 自動バックアップ（PWA）

- 状態: 設計のみ（コード未着手）。設計の検収待ち
- 作成: 2026-09-30 [claude]
- 範囲: 初版 v1.0.0 の全体（データ基盤／集計・予測／GitHub 自動バックアップと復元／自動アップデート／カレンダー書き出し／集計グラフ）
- 範囲外: UI の見た目（設計の合格後に Claude Design へ依頼する。本書は画面の「中身と振る舞い」だけ決める）、残量管理（消費の手入力）、複数端末・家族での共有、Web Push 通知、Swift 版

## 0. 前提と決定事項（2026-09-30 ユーザー回答）

| 項目 | 決定 |
|---|---|
| 形態 | PWA のみ（Swift へ移行しない） |
| 利用者 | 本人 1 人・iPhone 1 台（ホーム画面に追加して使う） |
| データの正本 | **端末内（IndexedDB）**。変更のたびに本人専用の非公開 GitHub リポジトリへ JSON を自動保存し、機種変更時はそこから復元する |
| 「現在合計何 kg」 | **累計購入量**（受け取った kg の合計）。残量は扱わない |
| 追加機能（採用） | 金額と支払い状況／次回予測のカレンダー登録（.ics）／年間・月別の集計グラフ |
| 追加機能（不採用） | 品種・年産・メモ欄 |

### 構成

| 要素 | 内容 |
|---|---|
| 技術 | Vite + React + TypeScript、`vite-plugin-pwa`（Libroli と同じ。自動更新の実績あり: Vault `Knowledge/pwa-auto-update-reload.md`）、IndexedDB は `idb` |
| コードのリポジトリ | `kome-app`（GitHub。GitHub Pages で配信するため公開リポジトリを想定。**データは一切含めない**。非公開にするなら Pages は有料プランが要る → 作成時にユーザーへ確認） |
| データのリポジトリ | `kome-data`（非公開）。`kome-backup.json` 1 ファイルを置く。1 回の保存が 1 コミットになるので、git の履歴がそのまま過去の版になる |
| 配信 | GitHub Actions で `main` への push ごとにビルドして GitHub Pages へ |
| 外部通信 | `api.github.com` だけ（書誌 API 等は無い） |

### 画面と表示する値（見た目は Claude Design）

| 画面 | 中身 |
|---|---|
| ホーム | 累計購入量（kg）／最終受取日と経過日数／次回購入の予測日と「あと N 日」（予測できないときは理由）／未払いの件数と金額／バックアップ状態（保存済み・保存待ち・エラー） |
| 記録の追加・編集 | 受取日（既定: 今日）、量 kg（既定: 前回の値、初回は 30）、代金（円・任意）、支払い済み（既定: 未払い）。編集・削除 |
| 記録一覧 | 受取日の新しい順。日付・kg・代金・kg 単価・支払い状況 |
| 集計 | 年ごとの kg・代金の合計、月別の kg（棒グラフ）、購入間隔の推移 |
| 設定 | GitHub バックアップの設定（トークン・リポジトリ名）と状態、今すぐ保存、GitHub から復元、復元の取り消し、JSON ファイル書き出し、カレンダー登録、バージョン表示 |

## 1. 不変条件

| # | 不変条件 |
|---|---|
| I1 | 「保存しました」を出すのは、IndexedDB のトランザクションが完了（`tx.done`）した後だけ。失敗したら入力内容を画面に残してエラーを出す |
| I2 | 端末に入る記録は必ず検証を通っている: `date` は実在する `YYYY-MM-DD` で今日以前／`kg` は 0 < kg ≤ 1000・小数 1 桁まで／`priceYen` は無しか 0 以上の整数／`paid` は真偽値。検証は 1 つの関数（`validateReceipt`）に集め、追加・編集・復元・取り込みの全経路が通る |
| I3 | 記録の変更と `dataRevision` の +1 は **同じトランザクション** で行う（片方だけ残らない） |
| I4 | 累計 kg・経過日数・予測・集計は保存しない。毎回、記録から計算する（食い違いの元を持たない） |
| I5 | GitHub 上の `kome-backup.json` は、常に「ある時点の端末データ全体」の完全な写し（1 ファイル 1 回の PUT で置き換え。部分書き込みをしない） |
| I6 | 古い写しが新しい写しを上書きしない。`lastPushedRevision` は増える方向にしか変わらず、送信中に端末が変われば送り直す |
| I7 | 自分の端末が書いたものでない GitHub 上のデータ（別の `deviceId`、読めない形式、手で編集されたもの）を、ユーザーの確認なしに上書きしない |
| I8 | 復元は全件入れ替えを 1 トランザクションで行い、直前の端末データを `preRestoreSnapshot` として同じトランザクションで残す（取り消せる）。途中で落ちても半端な状態にならない |
| I9 | 自分より新しい `schemaVersion` のバックアップや、検証を 1 件でも通らないバックアップは、1 件も適用せず拒否する |
| I10 | GitHub トークンは `Authorization` ヘッダで `api.github.com` へ送る以外に端末の外へ出さない（バックアップ JSON・書き出しファイル・URL・ログ・エラー表示に含めない） |
| I11 | 自動アップデートの再読み込みは、入力中（入力欄にフォーカス、または開いているフォームに未保存の変更がある）やダイアログ表示中には行わない |
| I12 | 予測は計算に使える受取日が 2 日以上あるときだけ出す。出せないときは理由を出す（0 除算・NaN・過去の予測日を「あと −N 日」と黙って出さない。予測日を過ぎたら「予測日を N 日過ぎています」と出す） |

## 2. 永続する状態

IndexedDB データベース `kome`（DB の版 1）。

| 場所 | 中身（形式） | 書く者 |
|---|---|---|
| store `receipts`（key: `id`） | `{ id: string(UUID), date: 'YYYY-MM-DD', kg: number, priceYen: number \| null, paid: boolean, createdAt: ISO8601, updatedAt: ISO8601 }` | `repo.addReceipt / updateReceipt / deleteReceipt / restoreFrom` |
| store `meta`, key `app` | `{ schemaVersion: 1, deviceId: string(UUID), dataRevision: number }` | 初回起動時の初期化、`repo` の各書き込み |
| store `meta`, key `backup` | `{ owner, repo, path: 'kome-backup.json', branch: 'main', lastPushedRevision: number, lastPushedSha: string \| null, lastPushedAt: ISO8601 \| null, status: 'off' \| 'ok' \| 'pending' \| 'error-auth' \| 'error-conflict' \| 'error-network', lastError: string \| null }` | 設定画面、`backup.push` |
| store `meta`, key `preRestoreSnapshot` | 復元直前の `receipts` 全件と `dataRevision`、取得時刻。無ければ未設定 | `repo.restoreFrom`、`repo.undoRestore`（使ったら消す） |
| store `secrets`, key `githubToken` | Fine-grained PAT の文字列 | 設定画面だけ |
| GitHub `kome-data/kome-backup.json` | §2.1 の形式 | `backup.push` だけ |
| Cache Storage | アプリ本体（precache。データは入れない） | Service Worker |
| `localStorage` | 使わない |  — |

- 日付はすべて端末の日付（日本時間）の `YYYY-MM-DD` 文字列で持つ。日数差は年月日を UTC の日付に直して引く（時刻・時差を混ぜない）
- 起動時に `navigator.storage.persist()` を要求する。Safari で開いたまま（ホーム画面に追加していない）ときは、7 日使わないと消えうるので追加を促す表示を出す

### 2.1 バックアップファイルの形式（外部との契約）

```json
{
  "format": "kome-backup",
  "schemaVersion": 1,
  "deviceId": "…",
  "revision": 12,
  "exportedAt": "2026-09-30T13:00:00.000Z",
  "appVersion": "1.0.0",
  "receipts": [ { "id": "…", "date": "2026-01-10", "kg": 30, "priceYen": 12000, "paid": true, "createdAt": "…", "updatedAt": "…" } ]
}
```

- `receipts` は `date` 昇順、同日は `createdAt` 昇順。インデント 2 の整形 JSON（GitHub 上の差分が読めるように）
- 手動の「JSON ファイル書き出し」も同じ形式。トークンは入れない（I10）
- 読み込み側: `format` が違う・`schemaVersion` が自分より大きい・1 件でも `validateReceipt` を通らない → 全体を拒否（I9）。自分より古い版は、版ごとの変換関数を通して現行の形にしてから検証する（v1 時点では変換なし）
- 未知のフィールドは v1 では保持しない（この形式を書くのはこのアプリだけのため）。§8 に記載

## 3. データを変えうる経路と塞ぎ方

| 経路 | 塞ぎ方 |
|---|---|
| 記録の追加・編集・削除（画面） | すべて `repo`（`src/data/repo.ts`）の関数を通す。各関数は 1 トランザクションで `validateReceipt` → `receipts` の書き込み → `meta.app.dataRevision` +1 を行う（I2・I3）。画面から `idb` を直接開かない |
| 復元（GitHub から／JSON ファイルから） | `repo.restoreFrom(backup)` の 1 本だけ。検証を全件通してから、1 トランザクションで `preRestoreSnapshot` 保存 → `receipts` 全削除 → 全件追加 → `dataRevision` を「現在の値 + 1」にする（I8・I9）。バックアップ側の `revision` を端末の番号にそのまま持ち込まない（番号が戻ると I6 が崩れるため） |
| 復元の取り消し | `repo.undoRestore()`。`preRestoreSnapshot` を 1 トランザクションで戻し、スナップショットを消し、`dataRevision` +1 |
| GitHub への自動保存 | `backup.push()` だけが GitHub へ書く。端末側で書くのは `meta.backup` だけ（`receipts` は読むだけ） |
| バックアップ設定・トークン | 設定画面 → `settings.saveBackupConfig()`。変更したら `lastPushedSha` を空に、`status` を `pending` に戻す（別のリポジトリへ向けた後に古い sha を使わない） |
| DB の版上げ（将来のアプリ更新） | `openDB` の `upgrade` の中だけ。版ごとの移行関数を順に当てる。他のタブが開いていれば `blocked`／`versionchange` で古い側は DB を閉じ、I11 の条件を満たした時点で再読み込み |
| 別のタブ・ホーム画面版と Safari 版の同時起動（PWA の抜け道） | 端末内の書き込みは IndexedDB のトランザクションで直列化される。GitHub への書き込みは Web Locks（`navigator.locks.request('kome-backup', …)`）で 1 つに絞る。変更後に `BroadcastChannel('kome')` で他タブへ知らせ、他タブは読み直す。※ iOS のホーム画面版と Safari 版は保存領域が別なので、互いのデータは見えない（§8） |
| Service Worker | アプリ本体のキャッシュだけを扱い、IndexedDB に触らない |
| GitHub 側での手編集・別端末からの書き込み | 端末へは自動で取り込まない。次の保存で sha が合わなくなったときに §4 の衝突として扱う（I7） |
| 試験用の入口 | `repo` を `fake-indexeddb` の上で直接呼ぶ。本番コードに試験専用の書き込み口は作らない |
| 変更の能力の持ち出し | `repo` は DB ハンドルやトランザクションを外へ返さない（戻り値は値のコピーだけ）。`idb` の `openDB` を呼ぶのは `src/data/db.ts` の 1 か所だけにし、grep で見張る（§9） |

## 4. 状態遷移（GitHub 自動保存）

`status` の遷移。`dirty` とは `dataRevision > lastPushedRevision`。

```
off ──設定を保存──▶ pending
ok ──端末で変更──▶ pending
pending ──送信成功（dirty でない）──▶ ok
pending ──送信成功（送信中に変更あり）──▶ pending（すぐ送り直す）
pending ──ネット不通・5xx・タイムアウト──▶ error-network（次のきっかけで再試行）
pending ──401／403──▶ error-auth（自動再試行を止める。トークン再設定で pending へ）
pending ──sha 不一致で他人のデータ──▶ error-conflict（自動再試行を止める。ユーザーが「端末の内容で上書き」か「GitHub から復元」を選ぶ）
error-network ──きっかけ──▶ pending
```

**送信のきっかけ**: 端末での変更の 3 秒後（連続した変更はまとめる）／起動時に dirty なら／画面が前面に戻ったとき dirty なら／`online` イベント／設定画面の「今すぐ保存」。

**1 回の送信（`backup.push`）**

1. Web Lock `kome-backup` を取る（取れなければ、実行中の送信に任せて終わる）
2. 1 つの読み取りトランザクションで `dataRevision`（= R）と `receipts` 全件を読み、§2.1 の JSON を作る
3. `PUT /repos/{owner}/{repo}/contents/{path}`（本文: base64 の JSON、`message: "kome: rev R（N件・累計 Xkg）"`、`branch`、`sha: lastPushedSha`（無ければ省く））
4. 成功（200／201）→ 1 つのトランザクションで `lastPushedSha` = 返ってきた sha、`lastPushedRevision = max(現在値, R)`、`lastPushedAt`、`status`（dirty なら `pending`、でなければ `ok`）を書く
5. sha 不一致（409／422、または sha を省いたのに既にファイルがある 422）→ `GET` で GitHub 上のファイルを読む:
   - 読めて、`format` が一致し、`deviceId` が自分で、`revision ≤ R` → 自分の古い写し。返ってきた sha で 3 からもう 1 回だけやり直す
   - それ以外（他の端末・手編集・読めない・`revision > R`）→ `error-conflict`。何も上書きしない（I7）
   - ファイルが無い（404）→ sha を省いて 3 からもう 1 回だけやり直す
6. ロックを外す。dirty が残っていれば 1 へ戻る（ループは 1 回の起動につき最大 5 周。超えたら `error-network` で止める）

**衝突の解決（ユーザー操作）**
- 「端末の内容で上書き」: GitHub 上の現在の sha を取り直して 3 を実行。上書き前の内容は GitHub の履歴に残る（取り消せる）ことを確認画面に書く
- 「GitHub から復元」: §6 の復元手順へ

## 5. 失敗・中断の地点ごとの表

| 落ちた／失敗した地点 | 端末・GitHub に残るもの | 次の起動・再試行での動き | 結果 |
|---|---|---|---|
| 記録の書き込みトランザクションの確定前 | 何も変わらない（IndexedDB が丸ごと取り消す） | 入力画面にエラーを出し、入力内容は画面に残す（アプリごと落ちたら入力は失われる） | 半端な記録は残らない（I1・I3） |
| 記録の確定後・送信の予約前 | 記録と +1 された `dataRevision` | 起動時に dirty を見て送信 | 送り漏れない |
| 送信の手順 2（写しを作る）の途中 | 端末は変わらない | 次のきっかけで最初から | 影響なし |
| PUT を送る前 | 端末は変わらない | 同上 | 影響なし |
| PUT が GitHub で確定したが、応答を受け取る前に落ちた | GitHub: 新しい写し（rev R）。端末: `lastPushedSha` は古いまま、dirty のまま | 次の送信で sha 不一致 → GET → 自分の `deviceId` かつ `revision ≤ 現在の R` → 新しい sha で上書き | 同じ内容を 2 回コミットするだけ（冪等） |
| 応答は受け取ったが、手順 4 の確定前に落ちた | 上と同じ | 上と同じ | 上と同じ |
| 手順 4 の確定後 | すべて整合 | — | 正常 |
| ネット不通・タイムアウト（15 秒） | 端末は dirty のまま | `error-network`、次のきっかけで再試行 | 端末のデータは失われない |
| トークン期限切れ・取り消し（401／403） | 端末は dirty のまま | `error-auth`。ホームと設定に「トークンを再設定してください」 | 再設定まで保存が止まることを表示で知らせる |
| 復元の検証中にエラー | 端末は変わらない | 理由を表示（形式違い・新しい版・何件目のどの値か） | 1 件も適用しない（I9） |
| 復元トランザクションの確定前に落ちた | 端末は復元前のまま（丸ごと取り消し） | もう一度復元できる | 半端な入れ替えにならない（I8） |
| 復元の確定後 | 新しいデータ、`preRestoreSnapshot`、+1 された `dataRevision` | dirty なので GitHub へ送る | 取り消しは `undoRestore` で可能 |
| Service Worker の更新途中 | 旧版のアプリ本体がキャッシュに残る | 次回の起動・前面復帰で更新を再確認 | データに影響なし |
| DB の版上げ（将来）の途中で落ちた | IndexedDB の版上げは 1 トランザクションなので旧版のまま | 次の起動で版上げをやり直す | 半端な移行にならない |

## 6. 起動時・再開時の手順

1. DB を開く。初めてなら `meta.app` を `{ schemaVersion: 1, deviceId: 新しい UUID, dataRevision: 0 }` で作り、`meta.backup` を `status: 'off'` で作る
2. `meta.app.schemaVersion` がアプリの知っている版より大きい（新しいアプリで書いた DB を古いアプリで開いた）→ 読み取り専用で開き、書き込みボタンを止めて「アプリを更新してください」を出す
3. `navigator.storage.persist()` を要求。ホーム画面から起動していない（`display-mode: standalone` でない）ときは追加を促す
4. 自動アップデートを準備（Libroli の方式: `controllerchange` で再読み込みを予約し、I11 の条件を満たしたら実行。前面復帰・フォーカス時と 1 時間ごとに `registration.update()`）
5. 画面を描く（記録を読んで計算。GitHub の結果を待たない）
6. バックアップ設定があり dirty なら、裏で送信（画面の描画を待たせない）
7. 知らない `status` の値に出会ったら `pending` として扱う

**機種変更・データを失ったときの復元**
1. 設定画面でトークンとリポジトリ名を入れる
2. 端末の記録が 0 件なら「GitHub から復元」を案内する。GET → 検証 → 件数と累計 kg と最終受取日を見せて確認 → `restoreFrom`
3. 端末に記録があるときは、件数を並べて見せ、「端末の N 件を GitHub の M 件で置き換えます」と確認してから実行
4. 復元後の `deviceId` は **今の端末のもの** を使う。GitHub 上のファイルは別の `deviceId` なので、最初の保存で sha 不一致になり `error-conflict` になる。これを避けるため、復元の確定時に `lastPushedSha` を GET で得た sha にし、`lastPushedRevision` を 0 のままにする（→ 次の保存は sha 一致で上書きに成功する。上書きしてよいのは、今まさにその内容を取り込んだため）

## 7. 並行・順序

- **端末内の書き込み**: IndexedDB が readwrite トランザクションを直列化する。`dataRevision` の +1 は読み取りと書き込みを同じトランザクションで行うので、同時に 2 つ来ても番号が飛んだり重なったりしない
- **GitHub への送信**: Web Lock で同時に 1 本。送信中に端末が変わった場合は、手順 4 で `lastPushedRevision = R`（送ったときの番号）にするので dirty が残り、手順 6 で送り直す（I6）
- **送信と復元が重なる**: 復元はバックアップの Web Lock を取ってから行う。送信中なら終わるのを待つ
- **await をまたぐ読み取り**: 写しは 1 つの読み取りトランザクション（`dataRevision` と全件）から作る。別々に読むと、間に入った変更で番号と中身がずれるため
- **複数タブ**: 変更後に `BroadcastChannel` で知らせ、他タブは読み直す。DB の版上げは `versionchange` で古いタブが閉じる
- **再入**: `repo` の関数の中から `backup.push` を直接呼ばない（送信は「予約」だけ。トランザクションの外で走らせる）。`backup.push` の中から `repo` の書き込み関数を呼ばない

## 8. 既知の限界・後回し

- iOS のホーム画面版と Safari 版は保存領域が別。Safari で記録した分はホーム画面版に出ない → Safari で開いたときに追加を促す表示で対処
- トークンは端末内に平文で置く（Web で安全に隠す手段は無い）。被害を狭めるため、**Fine-grained PAT で `kome-data` 1 つだけ・Contents の読み書きだけ** に絞る。外部スクリプトを読み込まない、`Content-Security-Policy` を meta で `default-src 'self'; connect-src 'self' https://api.github.com` にする
- Fine-grained PAT の有効期限の上限（無期限が選べるか）は未確認。期限切れは `error-auth` で知らせる設計で吸収する
- `api.github.com` の CORS がブラウザからの PAT 付き PUT を許すかは未確認（許す前提で設計）。実装の最初に確かめ、だめなら設計へ戻る
- iOS のホーム画面版での `.ics` の渡し方（Blob のダウンロードで「カレンダーに追加」が出るか、`navigator.share` のファイル共有が要るか）は未確認。実装時に実機相当で確かめる
- 予測は「最近の購入ペースが続く」前提の単純な計算。長期の不在・来客などは反映しない
- 未知のフィールドはバックアップで保持しない（形式を書くのがこのアプリだけのため）
- GitHub 側の履歴はコミットごとに増える（1 回 数 KB × 変更回数。年に数十回の想定で問題なし）

### 8.1 計算の定義（試験で固定する）

- **累計購入量** = 全記録の `kg` の合計（小数 1 桁で表示）
- **経過日数** = 今日 − 最新の受取日（日）
- **次回予測**: 受取日ごとに kg を合算した列を日付順に並べ、直近の最大 7 日分（間隔 6 つ）を使う。区間の長さ `span` = 最後の日 − 最初の日。区間で食べた量 = 最後の日を除く kg の合計。1 日の消費 `rate` = 食べた量 ÷ span。予測日 = 最後の日 + round(最後の日の kg ÷ rate)。受取日が 2 日未満、または `span` が 0 なら予測しない（I12）
- **平均購入間隔** = span ÷（使った日数 − 1）
- **kg 単価** = `priceYen ÷ kg`（代金が無ければ出さない）
- **未払い** = `paid === false` かつ `priceYen` がある記録の件数と合計（代金が空の未払いは件数だけ数える）
- **年・月の集計**: 受取日の年・月で分ける（日本の日付）
- **カレンダー（.ics）**: 予測日に終日の予定「お米の購入目安」、3 日前に通知（`VALARM TRIGGER:-P3D`）。UID は `kome-next@<deviceId>` で固定し、登録し直すと同じ予定の更新になるようにする

## 9. 不変条件と試験の対応

試験は Vitest ＋ `fake-indexeddb`、GitHub は `fetch` の差し替えで決定的に行う。結果の列は実装後に埋める。

| 不変条件 | 試験（予定） | 壊して確かめたこと（mutation） |
|---|---|---|
| I1 | 書き込みを失敗させたとき、成功を返さず入力値を保持する | （実装後） |
| I2 | 範囲外・未来日・存在しない日付・小数 2 桁・負の代金を、追加・編集・復元・JSON 取り込みの 4 経路それぞれで拒否する | |
| I3 | 書き込み途中で例外を起こすと、記録も `dataRevision` も変わらない | |
| I4 | grep: `receipts` 以外の store に累計・予測を書くコードが無い | |
| I5 | 送信する本文が全件を含み、§2.1 の形式を満たす | |
| I6 | 送信中（PUT の応答待ちで止める）に記録を足すと、手順 4 のあと dirty が残って送り直す。`lastPushedRevision` は減らない | |
| I7 | GitHub 上が別の `deviceId`／`revision > R`／壊れた JSON のとき、PUT を送らず `error-conflict` になる | |
| I8 | 復元トランザクションの途中で例外 → 端末は元のまま。確定後 `undoRestore` で完全に戻る | |
| I9 | `schemaVersion: 2`、1 件だけ不正な値、`format` 違いの各バックアップで 1 件も適用されない | |
| I10 | 書き出し JSON・送信本文・エラー文言にトークン文字列が含まれない。`fetch` の宛先が `api.github.com` だけ | |
| I11 | 入力欄にフォーカス中・フォームが未保存・ダイアログ表示中は再読み込みしない。解除後に再読み込みする | |
| I12 | 0 件・1 件・同日 2 件・通常 8 件・予測日超過の各ケースの表示値を固定する（§8.1 の計算） | |
| §3 の経路 | grep: `openDB` の呼び出しが `src/data/db.ts` だけ、`api.github.com` への `fetch` が `src/backup/` だけ、`secrets` を読むのが `backup` と設定画面だけ（全出現を許可リストと照合） | |
| §5 の中断 | PUT 確定後・応答前で落ちた状態を再現 → 次の送信で自分の写しと判定して上書きに成功する | |
