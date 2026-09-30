# Kome-app 設計書: 米の受取記録・予測・GitHub 自動バックアップ（PWA）

- 状態: 設計のみ（コード未着手）。改訂 1（初回設計検収 P1×5・P2×3 を反映）の再検収待ち
- 作成: 2026-09-30 [claude]／改訂 1: 2026-09-30 [claude]
- 範囲: 初版 v1.0.0 の全体（データ基盤／集計・予測／GitHub 自動バックアップと復元／自動アップデート／カレンダー書き出し／集計グラフ）
- 範囲外: UI の見た目（設計の合格後に Claude Design へ依頼する。本書は画面の「中身と振る舞い」だけ決める）、残量管理（消費の手入力）、複数端末・家族での共有、Web Push 通知、Swift 版

### 改訂 1 の変更点（初回検収の指摘との対応）

| 指摘 | 反映先 |
|---|---|
| P1-1 自分の写しの判定が推し量り | `pendingPush`（`writeId`＋本文の SHA-256）を PUT 前に確定し、GET した本文のハッシュ完全一致だけを自分の写しとする（I7・§2・§4・§5・§6・§9） |
| P1-2 保存先変更で初回送信されない | 保存先の系譜 `targetKey` を持ち、変更時に `lastPushedRevision` も 0 へ戻して送信を予約（§3・§4・§9） |
| P1-3 復元の確認から確定までの競合 | 確認時の端末 `dataRevision` と GitHub の blob sha を保持し、Web Lock 内で確定直前に再確認。関係する値をすべて同じトランザクションで更新（I8・§6・§7・§9） |
| P1-4 新しい DB を古いアプリで開けない | 読み取り専用で開く案をやめ、`VersionError`／新しい `schemaVersion` で「停止モード」に入る（§3・§6・§9） |
| P1-5 バックアップ全体の検証不足 | `validateBackup`（外枠と全件）を定義（I2・I9・§2.1・§9） |
| P2-1 Contents API の契約とエラー分類 | §4.1 を新設（`content.sha`、422・403・429 の分類、ヘッダ、`ref`） |
| P2-2 pending の確定点 | 状態は保存せず `dataRevision > lastPushedRevision` から導出（I3・§2・§4） |
| P2-3 未確認事項の整理 | CORS・PAT 期限を公式ドキュメントで確認済みに変更。.ics だけ実装スパイクとして残す（§8） |

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
| ホーム | 累計購入量（kg）／最終受取日と経過日数／次回購入の予測日と「あと N 日」（予測できないときは理由）／未払いの件数と金額／バックアップ状態（未設定・保存済み・保存待ち・エラーの種類） |
| 記録の追加・編集 | 受取日（既定: 今日）、量 kg（既定: 前回の値、初回は 30）、代金（円・任意）、支払い済み（既定: 未払い）。編集・削除 |
| 記録一覧 | 受取日の新しい順。日付・kg・代金・kg 単価・支払い状況 |
| 集計 | 年ごとの kg・代金の合計、月別の kg（棒グラフ）、購入間隔の推移 |
| 設定 | GitHub バックアップの設定（トークン・リポジトリ名）と状態、今すぐ保存、GitHub から復元、JSON ファイルから復元、復元の取り消し、JSON ファイル書き出し、カレンダー登録、バージョン表示 |

## 1. 不変条件

| # | 不変条件 |
|---|---|
| I1 | 「保存しました」を出すのは、IndexedDB のトランザクションが完了（`tx.done`）した後だけ。失敗したら入力内容を画面に残してエラーを出す |
| I2 | 端末に入る記録は必ず `validateReceipt` を通っている: `id` は UUID／`date` は実在する `YYYY-MM-DD` で今日以前／`kg` は 0 < kg ≤ 1000・小数 1 桁まで／`priceYen` は null か 0 以上の整数／`paid` は真偽値／`createdAt`・`updatedAt` は ISO 8601 で `updatedAt ≥ createdAt`。追加・編集・復元の全経路が通る。バックアップはさらに外枠ごと `validateBackup`（§2.1）を通る |
| I3 | 記録の変更と `dataRevision` の +1 は **同じトランザクション** で行う（片方だけ残らない）。「保存待ち」は保存せず、常に `dataRevision > lastPushedRevision` から導出する |
| I4 | 累計 kg・経過日数・予測・集計は保存しない。毎回、記録から計算する |
| I5 | GitHub 上の `kome-backup.json` は、常に「ある時点の端末データ全体」の完全な写し（1 ファイル 1 回の PUT で置き換え。部分書き込みをしない） |
| I6 | 古い写しが新しい写しを上書きしない。`lastPushedRevision` は同じ保存先の中では増える方向にしか変わらず、送信中に端末が変われば送り直す（保存先を変えたときだけ 0 に戻る） |
| I7 | GitHub 上のファイルを確認なしに上書きしてよいのは、(a) sha がこの端末の記録した `lastPushedSha` と一致するとき、または (b) GET した本文の SHA-256 がこの端末の `pendingPush.bodySha256` と完全一致するとき（＝自分が送った写しそのもの）だけ。`deviceId` や `revision` の値は判定に使わない。それ以外はユーザーの確認を取る |
| I8 | 復元は、確認した時点の端末 `dataRevision` と GitHub の blob sha が確定直前も変わっていないときだけ行う。全件入れ替え・`preRestoreSnapshot`・`dataRevision`・バックアップの系譜（`lastPushedSha`・`lastPushedRevision`・`pendingPush`・`errorKind`）の更新を 1 トランザクションで行う（取り消せる。途中で落ちても半端にならない） |
| I9 | `validateBackup` を通らないバックアップ（自分より新しい `schemaVersion`、外枠の不正、1 件でも不正な記録、ID の重複）は、1 件も適用せず拒否する |
| I10 | GitHub トークンは `Authorization` ヘッダで `api.github.com` へ送る以外に端末の外へ出さない（バックアップ JSON・書き出しファイル・URL・ログ・エラー表示に含めない） |
| I11 | 自動アップデートの再読み込みは、入力中（入力欄にフォーカス、または開いているフォームに未保存の変更がある）やダイアログ表示中には行わない |
| I12 | 予測は計算に使える受取日が 2 日以上あるときだけ出す。出せないときは理由を出す（0 除算・NaN を出さない。予測日を過ぎたら「予測日を N 日過ぎています」と出す） |
| I13 | 自分より新しい DB の版・`schemaVersion` に出会ったら「停止モード」に入り、端末のデータにも GitHub にも一切書かない |

## 2. 永続する状態

IndexedDB データベース `kome`（DB の版 1）。

| 場所 | 中身（形式） | 書く者 |
|---|---|---|
| store `receipts`（key: `id`） | `{ id: UUID, date: 'YYYY-MM-DD', kg: number, priceYen: number \| null, paid: boolean, createdAt: ISO8601, updatedAt: ISO8601 }` | `repo.addReceipt / updateReceipt / deleteReceipt / restoreFrom / undoRestore` |
| store `meta`, key `app` | `{ schemaVersion: 1, deviceId: UUID, dataRevision: number }` | 初回起動時の初期化、`repo` の各書き込み |
| store `meta`, key `backup` | `{ owner, repo, path: 'kome-backup.json', branch: 'main', targetKey: string \| null, lastPushedRevision: number, lastPushedSha: string \| null, lastPushedAt: ISO8601 \| null, pendingPush: PendingPush \| null, errorKind: null \| 'auth' \| 'config' \| 'conflict' \| 'invalid' \| 'network' \| 'rate-limit', retryAfter: ISO8601 \| null, lastErrorMessage: string \| null }` | 設定画面（`settings.saveBackupConfig`）、`backup.push`、`repo.restoreFrom / undoRestore` |
| 同上 `PendingPush` | `{ writeId: UUID, revision: number, bodySha256: hex, targetKey: string, startedAt: ISO8601 }`。PUT を送る前に確定し、成功または自分の写しと確かめた時点で消す | `backup.push` だけ |
| store `meta`, key `preRestoreSnapshot` | 復元直前の `receipts` 全件と `dataRevision`、取得時刻。無ければ未設定 | `repo.restoreFrom`、`repo.undoRestore`（使ったら消す） |
| store `secrets`, key `githubToken` | Fine-grained PAT の文字列 | 設定画面だけ |
| GitHub `kome-data/kome-backup.json` | §2.1 の形式 | `backup.push` だけ |
| Cache Storage | アプリ本体（precache。データは入れない） | Service Worker |
| `localStorage` | 使わない | — |

- `targetKey` = `owner/repo/branch/path` を連結した文字列。バックアップの系譜（`lastPushedSha`・`lastPushedRevision`・`pendingPush`）はこの保存先に対してだけ有効
- 表示するバックアップ状態は導出する: 設定なし → 未設定／`errorKind` あり → そのエラー／`pendingPush` あり、または `dataRevision > lastPushedRevision` → 保存待ち／それ以外 → 保存済み
- 日付はすべて端末の日付（日本時間）の `YYYY-MM-DD` 文字列で持つ。日数差は年月日を UTC の日付に直して引く
- 起動時に `navigator.storage.persist()` を要求する。Safari で開いたまま（ホーム画面に追加していない）ときは、7 日使わないと消えうるので追加を促す表示を出す

### 2.1 バックアップファイルの形式（外部との契約）

```json
{
  "format": "kome-backup",
  "schemaVersion": 1,
  "deviceId": "…",
  "writeId": "…",
  "revision": 12,
  "exportedAt": "2026-09-30T13:00:00.000Z",
  "appVersion": "1.0.0",
  "receipts": [ { "id": "…", "date": "2026-01-10", "kg": 30, "priceYen": 12000, "paid": true, "createdAt": "…", "updatedAt": "…" } ]
}
```

- `receipts` は `date` 昇順、同日は `createdAt` 昇順。インデント 2 の整形 JSON、末尾に改行 1 つ、UTF-8。**PUT する本文のバイト列そのもの**の SHA-256 を `bodySha256` にする
- `writeId` は送信のたびに新しく作る。手動の「JSON ファイル書き出し」も同じ形式（`writeId` は書き出しごとに新規）。トークンは入れない（I10）
- **`validateBackup(json)`**（書き込みの前に全体を検証。1 つでも外れたら全体を拒否し、理由を「どのキー／何件目のどの値か」で返す）:
  - トップレベル: オブジェクトである／`format === 'kome-backup'`／`schemaVersion` は 1 以上の整数で、アプリの知る版以下（大きければ「アプリを更新してください」）／`deviceId`・`writeId` は UUID／`revision` は 0 以上の安全な整数／`exportedAt` は ISO 8601／`appVersion` は文字列／`receipts` は配列
  - 各記録: `validateReceipt` を通る（I2）
  - 全体: `id` が重複しない
  - 未知のキーは読み捨てる（保持しない。§8）
  - 自分より古い `schemaVersion` は、版ごとの変換関数を通して現行の形にしてから検証する（v1 時点では変換なし）

## 3. データを変えうる経路と塞ぎ方

| 経路 | 塞ぎ方 |
|---|---|
| 記録の追加・編集・削除（画面） | すべて `repo`（`src/data/repo.ts`）の関数を通す。各関数は 1 トランザクションで `validateReceipt` → `receipts` の書き込み → `meta.app.dataRevision` +1 を行う（I2・I3）。画面から `idb` を直接開かない |
| 復元（GitHub から／JSON ファイルから） | `repo.restoreFrom(backup, expected)` の 1 本だけ。§6 の手順（確認時の値の再確認 → 1 トランザクションでの全件入れ替え）でしか呼ばれない。バックアップ側の `revision` を端末の番号に持ち込まない（端末の番号が戻ると I6 が崩れるため） |
| 復元の取り消し | `repo.undoRestore()`。`preRestoreSnapshot` を 1 トランザクションで戻し、スナップショットを消し、`dataRevision` +1（→ 保存待ちになり、次の送信で GitHub も取り消し後の内容になる。取り消し前の GitHub の内容は git の履歴に残る） |
| GitHub への自動保存 | `backup.push()` だけが GitHub へ書く。端末側で書くのは `meta.backup` だけ（`receipts` は読むだけ） |
| バックアップ設定 | 設定画面 → `settings.saveBackupConfig()`。**保存先（owner／repo／branch／path）が変わったら**、1 トランザクションで `targetKey` を更新し、`lastPushedSha = null`・`lastPushedRevision = 0`・`pendingPush = null`・`errorKind = null` にして、送信を予約する（記録が 0 件でも空の写しを送る。以後 dirty の判定が新しい保存先に対して正しくなる）。**トークンだけ**の変更では系譜を保ち、`errorKind` が `auth`／`config` なら消して送信を予約する |
| DB の版上げ（将来のアプリ更新） | `openDB('kome', KNOWN_DB_VERSION)` の `upgrade` の中だけ。版ごとの移行関数を順に当てる。他のタブが開いていれば `blocked`／`versionchange` で古い側は DB を閉じ、I11 の条件を満たした時点で再読み込み |
| 新しい DB を古いアプリで開く | `openDB` が `VersionError` で失敗する。これを捕まえて停止モード（I13）に入り、DB を読まない・書かない。`registration.update()` を呼んで新しいアプリの取得を促す。DB の版が同じでも `meta.app.schemaVersion` が知らない値なら同じく停止モード |
| 別のタブ・ホーム画面版と Safari 版の同時起動（PWA の抜け道） | 端末内の書き込みは IndexedDB のトランザクションで直列化される。GitHub への書き込みと復元は Web Locks（`navigator.locks.request('kome-backup', …)`）で 1 つに絞る。変更後に `BroadcastChannel('kome')` で他タブへ知らせ、他タブは読み直す。※ iOS のホーム画面版と Safari 版は保存領域が別なので、互いのデータは見えない（§8） |
| Service Worker | アプリ本体のキャッシュだけを扱い、IndexedDB に触らない |
| GitHub 側での手編集・別端末からの書き込み | 端末へは自動で取り込まない。次の保存で sha が合わなくなったときに §4 の衝突として扱う（I7） |
| 試験用の入口 | `repo`・`backup` を `fake-indexeddb` と差し替えた `fetch` の上で直接呼ぶ。本番コードに試験専用の書き込み口は作らない |
| 変更の能力の持ち出し | `repo` は DB ハンドルやトランザクションを外へ返さない（戻り値は値のコピーだけ）。`idb` の `openDB` を呼ぶのは `src/data/db.ts` の 1 か所だけにし、grep で見張る（§9） |

## 4. GitHub 自動保存

### 4.0 表示状態の遷移

表示状態は §2 の規則で導出する（保存しない）。エラーの種類 `errorKind` だけを保存する。

| errorKind | 付く条件 | 自動再試行 | 消える条件 |
|---|---|---|---|
| `network` | ネット不通・タイムアウト（15 秒）・5xx | 次のきっかけで再試行 | 送信成功 |
| `rate-limit` | §4.1 の rate limit 判定 | `retryAfter` を過ぎた後のきっかけで再試行 | 送信成功 |
| `auth` | 401、rate limit でない 403 | 止める | トークンの再設定 |
| `config` | PUT・GET で 404（リポジトリが無い・権限が無い） | 止める | 設定の保存 |
| `conflict` | §4.2 手順 7 の「それ以外」 | 止める | ユーザーが衝突を解決（§4.3） |
| `invalid` | sha 衝突でない 422、GET した内容の形式違い | 止める | 設定の保存、または衝突の解決 |

**送信のきっかけ**: 端末での変更の 3 秒後（連続した変更はまとめる）／起動時／画面が前面に戻ったとき／`online` イベント／設定の保存／設定画面の「今すぐ保存」。止める種類のエラーがあるときは、ユーザー操作（設定の保存・今すぐ保存・衝突の解決）以外のきっかけでは送らない。

### 4.1 GitHub Contents API の契約

- 共通ヘッダ: `Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`、`Authorization: Bearer <token>`。宛先は `https://api.github.com/repos/{owner}/{repo}/contents/{path}` だけ
- GET: `?ref={branch}`。応答の `sha`（blob sha）と `content`（base64）を使う。`encoding` が `base64` でない・`type` が `file` でないときは `invalid`
- PUT: 本文 `{ message, content: base64(本文バイト列), branch, sha? }`。成功（200／201）で次回に使うのは **`content.sha`（blob sha）**。`commit.sha` は使わない
- 状態コードの分類:
  - 200／201 → 成功
  - 401 → `auth`
  - 403 → `X-RateLimit-Remaining: 0` または `Retry-After` があれば `rate-limit`（`retryAfter` = `Retry-After` 秒後、無ければ `X-RateLimit-Reset`）、それ以外は `auth`
  - 429 → `rate-limit`（同上）
  - 404 → `config`
  - 409 → sha 衝突として §4.2 手順 7 へ
  - 422 → sha の不一致・未指定を示すもの（`sha` を送ったのに一致しない、または `sha` を省いたのに既にファイルがある）だけ sha 衝突として手順 7 へ。判定は応答メッセージではなく「直後の GET でファイルが存在し、その sha が送った sha と違う（または sha を送っていない）」ことで行う。それ以外の 422 は `invalid`
  - 5xx・ネット不通・タイムアウト → `network`
- CORS: GitHub REST API は任意の origin からの CORS に対応し、preflight で `Authorization` ヘッダと `PUT` を許可している（公式ドキュメントで 2026-09-30 確認）

### 4.2 1 回の送信（`backup.push`）

1. Web Lock `kome-backup` を取る（取れなければ、実行中の送信に任せて終わる）
2. `meta.backup.pendingPush` が残っていれば（前回の送信の結果が分からないまま終わった）、**先に照合する**: GET → 本文の SHA-256 が `pendingPush.bodySha256` と一致すれば自分の写しが届いていた → 1 トランザクションで `lastPushedSha` = GET の sha、`lastPushedRevision = max(現在値, pendingPush.revision)`、`pendingPush = null`。一致しなければ手順 7 と同じ判定（`lastPushedSha` と GET の sha が一致すれば、PUT は届いていなかった → `pendingPush = null` にして続ける。一致しなければ `conflict`）。404 なら `pendingPush = null` にして続ける
3. dirty（`dataRevision > lastPushedRevision`）でなければ 10 へ
4. 1 つの読み取りトランザクションで `dataRevision`（= R）と `receipts` 全件を読み、新しい `writeId` で §2.1 の本文を作り、SHA-256 を計算する
5. 1 トランザクションで `pendingPush = { writeId, revision: R, bodySha256, targetKey, startedAt }` を確定する（**PUT より前**）
6. PUT（`message: "kome: rev R（N件・累計 Xkg）"`、`sha: lastPushedSha`（null なら省く））
7. 応答で分ける:
   - 成功 → 1 トランザクションで `lastPushedSha` = `content.sha`、`lastPushedRevision = max(現在値, R)`、`lastPushedAt`、`pendingPush = null`、`errorKind = null`
   - sha 衝突（§4.1）→ GET し、本文の SHA-256 が `pendingPush.bodySha256` と一致すれば自分の写し（PUT が確定していた）→ 成功と同じ更新（sha は GET のもの）。GET が 404 で `lastPushedSha` が null でないなら、`lastPushedSha = null` にして 6 へ 1 回だけ戻る。**それ以外はすべて** `errorKind = 'conflict'`、`pendingPush = null` にして何も上書きしない（I7）
   - `network`・`rate-limit` → `pendingPush` は **残す**（届いたかどうか分からないため。次回の手順 2 で照合する）。`errorKind` を記録
   - `auth`・`config`・`invalid` → 届いていないことが確かなので `pendingPush = null`。`errorKind` を記録
8. 送信中に端末が変わっていれば dirty が残る（手順 7 で `lastPushedRevision = R` にしたため）
9. dirty が残り、エラーが無ければ 3 へ戻る（1 回の起動につき最大 5 周。超えたら `network` で止める）
10. ロックを外す

### 4.3 衝突の解決（ユーザー操作）

`conflict` のとき、ホームと設定に「GitHub 側に、この端末が送っていないデータがあります」と出し、GET した内容の件数・累計 kg・最終受取日と、端末の同じ値を並べて見せる。

- 「端末の内容で上書き」: Web Lock 内で GET の sha を取り直し、1 トランザクションで `lastPushedSha` = その sha、`errorKind = null` にして手順 3 から送る。確認画面に「上書き前の内容は GitHub の履歴に残る」ことを書く
- 「GitHub から復元」: §6 の復元手順へ

## 5. 失敗・中断の地点ごとの表

| 落ちた／失敗した地点 | 端末・GitHub に残るもの | 次の起動・再試行での動き | 結果 |
|---|---|---|---|
| 記録の書き込みトランザクションの確定前 | 何も変わらない（IndexedDB が丸ごと取り消す） | 入力画面にエラーを出し、入力内容は画面に残す（アプリごと落ちたら入力は失われる） | 半端な記録は残らない（I1・I3） |
| 記録の確定後・送信の予約前 | 記録と +1 された `dataRevision`（→ 表示は保存待ち） | 起動時に dirty を見て送信 | 送り漏れない。「保存済み」と誤表示しない |
| 送信の手順 4（写しを作る）の途中 | 端末は変わらない | 次のきっかけで最初から | 影響なし |
| `pendingPush` の確定前（手順 5 の前） | 端末は変わらない | 同上 | 影響なし |
| `pendingPush` の確定後・PUT を送る前 | `pendingPush`（GitHub は旧版のまま） | 手順 2: GET の sha が `lastPushedSha` と一致 → PUT は届いていない → `pendingPush` を消して送り直す | 影響なし |
| PUT が GitHub で確定したが、応答を受け取る前に落ちた | GitHub: 新しい写し。端末: `pendingPush` が残る、`lastPushedSha` は古い | 手順 2: GET 本文のハッシュが `pendingPush` と一致 → 自分の写しと確定し、GET の sha を記録。重複コミットを作らない | 冪等 |
| 応答は受け取ったが、手順 7 の確定前に落ちた | 上と同じ | 上と同じ | 上と同じ |
| 手順 7 の確定後 | すべて整合 | — | 正常 |
| ネット不通・タイムアウト | `pendingPush` が残る、dirty のまま | `network`、次のきっかけで手順 2 から | 届いていても届いていなくても手順 2 で確定できる |
| rate limit（403／429） | 同上 | `retryAfter` を過ぎてから再試行 | 同上 |
| トークン期限切れ・取り消し（401／403） | `pendingPush` は消える、dirty のまま | `auth`。ホームと設定に「トークンを再設定してください」 | 再設定まで保存が止まることを表示で知らせる |
| 保存先の設定変更の確定前 | 旧設定のまま | — | 影響なし |
| 保存先の設定変更の確定後・最初の送信前 | 新しい `targetKey`、`lastPushedRevision = 0`（dirty） | 起動時・次のきっかけで新しい保存先へ全件を送る | 送り漏れない（P1-2） |
| 復元の検証中にエラー | 端末は変わらない | 理由を表示 | 1 件も適用しない（I9） |
| 復元の確認画面を出したあと、別タブで記録が変わった／GitHub が変わった | 端末・GitHub は変わったまま | 確定時の再確認で不一致 → 置き換えずに再プレビューへ戻る | 古い確認で置き換えない（I8） |
| 復元トランザクションの確定前に落ちた | 端末は復元前のまま（丸ごと取り消し） | もう一度復元できる | 半端な入れ替えにならない（I8） |
| 復元の確定後 | 新しいデータ、`preRestoreSnapshot`、+1 された `dataRevision`、GitHub の sha を引き継いだ系譜 | 保存済み表示（GitHub と同じ内容のため）。次の変更から通常どおり送る | 取り消しは `undoRestore` で可能 |
| Service Worker の更新途中 | 旧版のアプリ本体がキャッシュに残る | 次回の起動・前面復帰で更新を再確認 | データに影響なし |
| DB の版上げ（将来）の途中で落ちた | IndexedDB の版上げは 1 トランザクションなので旧版のまま | 次の起動で版上げをやり直す | 半端な移行にならない |
| 新しい DB を古いアプリで開いた | 何も変わらない | 停止モード。アプリの更新を取りに行く | 書かない（I13） |

## 6. 起動時・再開時の手順

1. `openDB('kome', KNOWN_DB_VERSION)` で開く。`VersionError` なら停止モード（I13）: 「新しい版のアプリで作られたデータです。アプリを更新してください」を出し、`registration.update()` を呼び、以降の手順を行わない
2. 初めてなら `meta.app` を `{ schemaVersion: 1, deviceId: 新しい UUID, dataRevision: 0 }` で作り、`meta.backup` を設定なし（`targetKey: null`）で作る
3. `meta.app.schemaVersion` がアプリの知っている版より大きい → 停止モード（手順 1 と同じ）
4. `navigator.storage.persist()` を要求。ホーム画面から起動していない（`display-mode: standalone` でない）ときは追加を促す
5. 自動アップデートを準備（Libroli の方式: `controllerchange` で再読み込みを予約し、I11 の条件を満たしたら実行。前面復帰・フォーカス時と 1 時間ごとに `registration.update()`）
6. 画面を描く（記録を読んで計算。GitHub の結果を待たない）
7. バックアップ設定があれば、裏で `backup.push()`（手順 2 の照合を含む。画面の描画を待たせない）
8. 知らない `errorKind` の値に出会ったら `null` として扱う

### 6.1 復元（GitHub から／JSON ファイルから）

1. **取得と検証**: GitHub なら GET（本文と blob sha）、ファイルならファイル読み込み。`validateBackup` を通す。通らなければ理由を出して終わり（I9）
2. **確認**: 端末の件数・累計 kg・最終受取日と、バックアップの同じ値を並べて見せる。このときの端末 `dataRevision`（= D0）と、GitHub の blob sha（= S0。ファイルからの復元なら無し）を控える。確認文:
   - 「端末の N 件を、バックアップの M 件で置き換えます。置き換え前の端末の内容は、この端末の中に 1 つだけ残り、取り消せます」
   - GitHub からの復元では追加で「復元後は、この端末がこのバックアップを引き継いで GitHub を更新します」
3. **確定**: 「置き換える」を押したら Web Lock `kome-backup` を取り、ロックの中で:
   1. GitHub からの復元なら、GET し直して sha が S0 と同じか確かめる。違えば手順 1 へ戻る（新しい内容で確認し直す）
   2. 1 つの readwrite トランザクションで `dataRevision` を読み、D0 と同じか確かめる。違えばトランザクションを中止して手順 1 へ戻る
   3. 同じトランザクションで: `preRestoreSnapshot` = 現在の全件と D0／`receipts` 全削除 → 全件追加／`dataRevision = D0 + 1`／バックアップの系譜を更新:
      - GitHub からの復元（保存先が今の設定と同じ）: `lastPushedSha = S0`、`lastPushedRevision = D0 + 1`（GitHub と端末が同じ内容なので保存済み）、`pendingPush = null`、`errorKind = null`
      - JSON ファイルからの復元: 系譜は変えない（`lastPushedRevision < D0 + 1` なので保存待ちになり、次の送信で GitHub に送られる。GitHub の sha が一致しなければ通常どおり `conflict`）
4. ロックを外し、`BroadcastChannel` で他タブへ知らせる

機種変更のときは、設定画面でトークンとリポジトリ名を入れ（→ 保存先の系譜が新しくなり `lastPushedRevision = 0`）、記録が 0 件なら「GitHub から復元」を案内する。案内より先に自動送信が走ると空の写しで上書きしかねないので、**端末の記録が 0 件で、保存先に既にファイルがある場合**は PUT が sha 衝突（sha を省いたため）になり `conflict` で止まる（I7）。`conflict` の画面から「GitHub から復元」を選べる。

## 7. 並行・順序

- **端末内の書き込み**: IndexedDB が readwrite トランザクションを直列化する。`dataRevision` の +1 は読み取りと書き込みを同じトランザクションで行うので、同時に 2 つ来ても番号が飛んだり重なったりしない
- **GitHub への送信**: Web Lock で同時に 1 本。送信中に端末が変わった場合は、手順 7 で `lastPushedRevision = R`（送ったときの番号）にするので dirty が残り、送り直す（I6）
- **送信と復元・衝突の解決が重なる**: どれも同じ Web Lock を取ってから行う。送信中なら終わるのを待つ
- **復元の確認中に別タブで変更**: 確定時に D0 と比べて検出し、置き換えない（§6.1 手順 3）
- **await をまたぐ読み取り**: 写しは 1 つの読み取りトランザクション（`dataRevision` と全件）から作る。IndexedDB のトランザクションは await で他の Promise（fetch・SHA-256 の計算）を待つと自動で閉じるので、トランザクションの中で fetch やハッシュ計算を待たない（読み終えてから計算する）
- **複数タブ**: 変更後に `BroadcastChannel` で知らせ、他タブは読み直す。DB の版上げは `versionchange` で古いタブが閉じる
- **再入**: `repo` の関数の中から `backup.push` を直接呼ばない（送信は「予約」だけ。トランザクションの外で走らせる）。`backup.push` の中から `repo` の記録の書き込み関数を呼ばない。復元（`repo.restoreFrom`）は Web Lock を持った呼び出し側から呼ばれ、その中で `backup.push` を呼ばない

## 8. 既知の限界・後回し

- iOS のホーム画面版と Safari 版は保存領域が別。Safari で記録した分はホーム画面版に出ない → Safari で開いたときに追加を促す表示で対処
- トークンは端末内に平文で置く（Web で安全に隠す手段は無い）。被害を狭めるため、**Fine-grained PAT で `kome-data` 1 つだけ・Contents の読み書きだけ** に絞る。外部スクリプトを読み込まない。`Content-Security-Policy` を meta で `default-src 'self'; connect-src 'self' https://api.github.com` にする
- 確認済み（公式ドキュメント、2026-09-30）:
  - GitHub REST API は任意の origin からの CORS に対応し、preflight で `Authorization` と `PUT` を許可している
  - Fine-grained PAT は無期限も選べる（組織・Enterprise のポリシーで上限を課される場合がある。個人リポジトリなので対象外の見込み）。期限を付けた場合の期限切れは `auth` で知らせる
- 実装の最初に確かめる（だめなら実装を止めて設計の再検収へ戻る）:
  - 専用の空リポジトリで、ブラウザから GET／新規 PUT／sha 付き更新／sha 不一致が通しで動くこと（公式上は通る。環境固有の不通の確認）
  - iOS のホーム画面版での `.ics` の渡し方（Blob のダウンロードで「カレンダーに追加」が出るか、`navigator.share` のファイル共有が要るか）
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

試験は Vitest ＋ `fake-indexeddb`、GitHub は `fetch` の差し替えで決定的に行う（送信の途中で止める試験は、差し替えた `fetch` の中の barrier で止める）。結果の列は実装後に埋める。

| 不変条件 | 試験（予定） | 壊して確かめたこと（mutation） |
|---|---|---|
| I1 | 書き込みを失敗させたとき、成功を返さず入力値を保持する | （実装後） |
| I2 | 範囲外・未来日・存在しない日付・小数 2 桁・負の代金・UUID でない id・不正な日時・`updatedAt < createdAt` を、追加・編集・復元の各経路で拒否する | |
| I3 | 書き込み途中で例外を起こすと、記録も `dataRevision` も変わらない。記録の確定直後に落とした状態で、表示状態が「保存待ち」になる | |
| I4 | grep: `receipts` 以外の store に累計・予測を書くコードが無い | |
| I5 | 送信する本文が全件を含み、`validateBackup` を通る | |
| I6 | 送信中（PUT の応答待ちで止める）に記録を足すと、手順 7 のあと dirty が残って送り直す。`lastPushedRevision` は減らない | |
| I7-a | GitHub 上が手編集された JSON（`deviceId`・`revision` は端末と同じ、本文は違う）のとき、PUT を送らず `conflict` になる | |
| I7-b | `pendingPush` 確定後・PUT 前で落とす → 次回の手順 2 で PUT していないと判定して送り直す（コミットは 1 つ） | |
| I7-c | PUT 確定後・応答前で落とす → 次回の手順 2 で自分の写しと判定し、GET の sha を記録する（重複コミットを作らない） | |
| I7-d | ネット不通で失敗 → `pendingPush` が残り、次回は照合から始まる | |
| 保存先変更 | 保存先を変えると、記録を足さなくても全件が新しい保存先へ送られる。新しい保存先に既にファイルがあれば `conflict` で止まる。トークンだけの変更では系譜が変わらない | |
| I8 | 確認後に別タブで記録を足す → 確定で置き換えず再確認へ。確認後に GitHub の sha が変わる → 同上。復元トランザクションの途中で例外 → 端末は元のまま。確定後 `undoRestore` で完全に戻る。GitHub から復元した直後は「保存済み」で、次の変更の PUT が S0 を sha にして成功する | |
| I9 | `schemaVersion: 2`、`format` 違い、`receipts` が配列でない、`revision` が負・小数、`deviceId`・`writeId` が UUID でない、`exportedAt` が不正、1 件だけ不正な記録、`id` の重複の各バックアップで 1 件も適用されない | |
| I10 | 書き出し JSON・送信本文・エラー文言にトークン文字列が含まれない。`fetch` の宛先が `api.github.com` だけ | |
| I11 | 入力欄にフォーカス中・フォームが未保存・ダイアログ表示中は再読み込みしない。解除後に再読み込みする | |
| I12 | 0 件・1 件・同日 2 件・通常 8 件・予測日超過の各ケースの表示値を固定する（§8.1 の計算） | |
| I13 | 版 2 で作った DB を版 1 のアプリで開く → `VersionError` を捕まえて停止モード、DB・GitHub へ書かない。`schemaVersion: 2` の `meta.app` でも同じ | |
| §4.1 の契約 | 送るヘッダ・`ref`・PUT の本文の形を固定。応答の `content.sha` を記録し `commit.sha` を記録しない。403（rate limit ヘッダあり／なし）・429・404・一般の 422・sha 不一致の 422・409 の各分類 | |
| §3 の経路 | grep: `openDB` の呼び出しが `src/data/db.ts` だけ、`api.github.com` への `fetch` が `src/backup/` だけ、`secrets` を読むのが `backup` と設定画面だけ（全出現を許可リストと照合） | |
