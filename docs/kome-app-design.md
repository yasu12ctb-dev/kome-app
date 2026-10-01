# Kome-app 設計書: 米の受取記録・予測・GitHub 自動バックアップ（PWA）

- 状態: 設計検収 合格（2026-10-01、改訂 3）・成立性確認済み（§8。ブラウザから PAT 付きの通し確認は U2 の冒頭で必須の関門として行う）。U1 の実装に着手
- 作成: 2026-09-30 [claude]／改訂 1・改訂 2: 2026-09-30 [claude]／改訂 3: 2026-10-01 [claude]
- 範囲: 初版 v1.0.0 の全体（データ基盤／集計・予測／GitHub 自動バックアップと復元／自動アップデート／カレンダー書き出し／集計グラフ）
- 範囲外: UI の見た目（設計の合格後に Claude Design へ依頼する。本書は画面の「中身と振る舞い」だけ決める）、残量管理（消費の手入力）、複数端末・家族での共有、Web Push 通知、Swift 版

### 改訂の変更点

**改訂 3**（改訂 2 の再検収。構造は妥当とされ、関所の操作表の穴 2 つを閉じた）

| 指摘 | 反映先 |
|---|---|
| P1-1 `recordError` が `writeId` を確かめず、同じ世代の古い送信のエラーが新しい送信の `pendingPush` を消せる | 送信・照合に由来するエラーは `recordPushError(gen, writeId, …)` だけにし、今の `pendingPush.writeId` と一致するときだけ書く。`writeId` を持たないエラー操作は置かない（5 周の上限はエラーを書かずに止める）（I14・§4.2・§4.4・§9） |
| P2-1 「今すぐ保存」がエラーを消す関所の操作が無い | 関所に `clearErrorForRetry(gen)` を追加（Web Lock 内・世代の一致）（§4.0・§4.4・§9） |

**改訂 2**（再検収の指摘。2 回続けてバックアップの系譜に指摘が集まったため、継ぎ足しではなく §2.2 の「系譜」の構造と §4.4 の「系譜の関所」に作り直した）

| 指摘 | 反映先 |
|---|---|
| P1-1 revision 0 の端末で新しい保存先へ初回送信が起きない | `lastPushedRevision` を `number \| null` にし、null＝この保存先へまだ送っていない。送信の要否を `needsPush`（§2.2）1 つに定義 |
| P1-2 PUT 中の保存先変更で旧応答が新しい系譜へ書かれる | 系譜に世代 `generation` を持たせ、系譜の書き換えは §4.4 の関所 1 本だけにし、世代と `writeId` が一致しないと書かない。設定の保存も Web Lock 内 |
| P1-3 JSON 復元で古い `pendingPush` が残る | 復元は系譜の関所の「復元」操作で `pendingPush`・`errorKind`・`retryAfter` を必ず消す（§4.4） |
| P2-1 判定用 GET の失敗時の分岐 | §4.2 の照合 GET・§4.2 手順 7 の GET の失敗を §4.1 の分類で決め、成功・`conflict` へ進めない（§4.2・§5・§9） |

**改訂 1**（初回検収 P1×5・P2×3）

| 指摘 | 反映先 |
|---|---|
| P1-1 自分の写しの判定が推し量り | `pendingPush`（`writeId`＋本文の SHA-256）を PUT 前に確定し、GET した本文のハッシュ完全一致だけを自分の写しとする |
| P1-2 保存先変更で初回送信されない | 改訂 2 で作り直し |
| P1-3 復元の確認から確定までの競合 | 確認時の端末 `dataRevision` と GitHub の blob sha を保持し、Web Lock 内で確定直前に再確認（§6.1） |
| P1-4 新しい DB を古いアプリで開けない | `VersionError`／新しい `schemaVersion` で停止モード（I13） |
| P1-5 バックアップ全体の検証不足 | `validateBackup`（§2.1） |
| P2-1 Contents API の契約とエラー分類 | §4.1 |
| P2-2 pending の確定点 | 状態は保存せず導出（§2.2） |
| P2-3 未確認事項の整理 | §8 |

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
| I3 | 記録の変更と `dataRevision` の +1 は **同じトランザクション** で行う（片方だけ残らない）。「保存待ち」は保存せず、常に `needsPush`（§2.2）から導出する |
| I4 | 累計 kg・経過日数・予測・集計は保存しない。毎回、記録から計算する |
| I5 | GitHub 上の `kome-backup.json` は、常に「ある時点の端末データ全体」の完全な写し（1 ファイル 1 回の PUT で置き換え。部分書き込みをしない） |
| I6 | 古い写しが新しい写しを上書きしない。同じ世代の中で `lastPushedRevision` は増える方向にしか変わらず、送信中に端末が変われば送り直す |
| I7 | GitHub 上のファイルを確認なしに上書きしてよいのは、(a) sha がこの世代の `lastPushedSha` と一致するとき、または (b) GET した本文の SHA-256 がこの世代の `pendingPush.bodySha256` と完全一致するとき（＝自分が送った写しそのもの）だけ。`deviceId` や `revision` の値は判定に使わない。それ以外はユーザーの確認を取る |
| I8 | 復元は、確認した時点の端末 `dataRevision`・系譜の世代・（GitHub からなら）blob sha が、確定直前も変わっていないときだけ行う。全件入れ替え・`preRestoreSnapshot`・`dataRevision`・系譜の更新を 1 トランザクションで行う |
| I9 | `validateBackup` を通らないバックアップ（自分より新しい `schemaVersion`、外枠の不正、1 件でも不正な記録、ID の重複）は、1 件も適用せず拒否する |
| I10 | GitHub トークンは `Authorization` ヘッダで `api.github.com` へ送る以外に端末の外へ出さない（バックアップ JSON・書き出しファイル・URL・ログ・エラー表示に含めない） |
| I11 | 自動アップデートの再読み込みは、入力中（入力欄にフォーカス、または開いているフォームに未保存の変更がある）やダイアログ表示中には行わない |
| I12 | 予測は計算に使える受取日が 2 日以上あるときだけ出す。出せないときは理由を出す（0 除算・NaN を出さない。予測日を過ぎたら「予測日を N 日過ぎています」と出す） |
| I13 | 自分より新しい DB の版・`schemaVersion` に出会ったら「停止モード」に入り、端末のデータにも GitHub にも一切書かない |
| I14 | 系譜（§2.2）を書き換えるのは §4.4 の関所だけ。関所は、呼び出し側が持つ世代が今の系譜と一致しないとき、また送信・照合の結果（成功・エラーとも）なら `writeId` が今の `pendingPush.writeId` と一致しないとき、何も書かない（古い送信の結果が、新しい保存先の系譜にも、同じ保存先の新しい送信にも入らない） |

## 2. 永続する状態

IndexedDB データベース `kome`（DB の版 1）。

| 場所 | 中身（形式） | 書く者 |
|---|---|---|
| store `receipts`（key: `id`） | `{ id: UUID, date: 'YYYY-MM-DD', kg: number, priceYen: number \| null, paid: boolean, createdAt: ISO8601, updatedAt: ISO8601 }` | `repo.addReceipt / updateReceipt / deleteReceipt`、系譜の関所の `restore / undoRestore` 操作（§4.4） |
| store `meta`, key `app` | `{ schemaVersion: 1, deviceId: UUID, dataRevision: number }` | 初回起動時の初期化、`repo` の各書き込み、系譜の関所の `restore / undoRestore` |
| store `meta`, key `backup` | §2.2 の系譜 | **系譜の関所（§4.4）だけ** |
| store `meta`, key `preRestoreSnapshot` | 復元直前の `receipts` 全件と `dataRevision`、取得時刻。無ければ未設定 | 系譜の関所の `restore / undoRestore`（使ったら消す） |
| store `secrets`, key `githubToken` | Fine-grained PAT の文字列 | 系譜の関所の `saveConfig` だけ |
| GitHub `kome-data/kome-backup.json` | §2.1 の形式 | `backup.push`・衝突の解決だけ |
| Cache Storage | アプリ本体（precache。データは入れない） | Service Worker |
| `localStorage` | 使わない | — |

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

- `receipts` は `date` 昇順、同日は `createdAt` 昇順。インデント 2 の整形 JSON、末尾に改行 1 つ、UTF-8。**PUT する本文のバイト列そのもの**の SHA-256 を `bodySha256` にする。記録が 0 件なら `receipts: []`
- `writeId` は送信のたびに新しく作る。手動の「JSON ファイル書き出し」も同じ形式（`writeId` は書き出しごとに新規）。トークンは入れない（I10）
- **`validateBackup(json)`**（書き込みの前に全体を検証。1 つでも外れたら全体を拒否し、理由を「どのキー／何件目のどの値か」で返す）:
  - トップレベル: オブジェクトである／`format === 'kome-backup'`／`schemaVersion` は 1 以上の整数で、アプリの知る版以下（大きければ「アプリを更新してください」）／`deviceId`・`writeId` は UUID／`revision` は 0 以上の安全な整数／`exportedAt` は ISO 8601／`appVersion` は文字列／`receipts` は配列
  - 各記録: `validateReceipt` を通る（I2）
  - 全体: `id` が重複しない
  - 未知のキーは読み捨てる（保持しない。§8）
  - 自分より古い `schemaVersion` は、版ごとの変換関数を通して現行の形にしてから検証する（v1 時点では変換なし）

### 2.2 バックアップの系譜（`meta.backup`）

「どの保存先に、端末のどの版まで送ったか」を 1 つのまとまりとして持つ。

```ts
type Lineage = {
  config: { owner: string; repo: string; branch: string; path: 'kome-backup.json' } | null; // null = 未設定
  generation: UUID;                 // 保存先を設定・変更するたびに新しくする
  lastPushedSha: string | null;     // この世代で最後に確かめた GitHub の blob sha
  lastPushedRevision: number | null;// この世代で GitHub に届いたと確かめた端末の dataRevision。null = この世代ではまだ何も届いていない
  lastPushedAt: ISO8601 | null;
  pendingPush: { writeId: UUID; generation: UUID; revision: number; bodySha256: hex; startedAt: ISO8601 } | null;
                                    // PUT を送る前に確定。届いたかどうか確かめた時点で消す
  errorKind: null | 'auth' | 'config' | 'conflict' | 'invalid' | 'network' | 'rate-limit';
  retryAfter: ISO8601 | null;
  lastErrorMessage: string | null;
};
```

- **`needsPush`** = `config !== null` かつ（`pendingPush !== null` または `lastPushedRevision === null` または `dataRevision > lastPushedRevision`）。送信の要否も「保存待ち」の表示もこれだけで決める
- 表示するバックアップ状態: `config` が null → 未設定／`errorKind` あり → そのエラー／`needsPush` → 保存待ち／それ以外 → 保存済み
- 初期値（初回起動時）: `config: null`、`generation`: 新しい UUID、`lastPushedSha: null`、`lastPushedRevision: null`、`pendingPush: null`、`errorKind: null`

## 3. データを変えうる経路と塞ぎ方

| 経路 | 塞ぎ方 |
|---|---|
| 記録の追加・編集・削除（画面） | すべて `repo`（`src/data/repo.ts`）の関数を通す。各関数は 1 トランザクションで `validateReceipt` → `receipts` の書き込み → `meta.app.dataRevision` +1 を行う（I2・I3）。画面から `idb` を直接開かない。`repo` は `meta.backup` に触らない |
| 系譜（`meta.backup`）・トークン・復元 | すべて §4.4 の系譜の関所（`src/backup/lineage.ts`）を通す。関所の外から `meta.backup`・`secrets`・`preRestoreSnapshot` を書かない（I14） |
| 復元（GitHub から／JSON ファイルから） | §6.1 の手順でだけ、関所の `restore` 操作を呼ぶ。バックアップ側の `revision` を端末の番号に持ち込まない |
| 復元の取り消し | 関所の `undoRestore` 操作 |
| GitHub への自動保存 | `backup.push()`（§4.2）だけが GitHub へ書き、結果は関所の `recordPush*` 操作で系譜へ書く |
| バックアップ設定 | 設定画面 → 関所の `saveConfig` 操作（Web Lock 内。§4.4） |
| DB の版上げ（将来のアプリ更新） | `openDB('kome', KNOWN_DB_VERSION)` の `upgrade` の中だけ。版ごとの移行関数を順に当てる。他のタブが開いていれば `blocked`／`versionchange` で古い側は DB を閉じ、I11 の条件を満たした時点で再読み込み |
| 新しい DB を古いアプリで開く | `openDB` が `VersionError` で失敗する。これを捕まえて停止モード（I13）に入り、DB を読まない・書かない。`registration.update()` を呼んで新しいアプリの取得を促す。DB の版が同じでも `meta.app.schemaVersion` が知らない値なら同じく停止モード |
| 別のタブ・ホーム画面版と Safari 版の同時起動（PWA の抜け道） | 端末内の書き込みは IndexedDB のトランザクションで直列化される。GitHub への書き込み・復元・設定の保存・衝突の解決は Web Lock `kome-backup` で 1 つに絞る。さらに関所が世代と `writeId` を比べるので、ロックの外から来た古い結果も書かれない（I14）。変更後に `BroadcastChannel('kome')` で他タブへ知らせ、他タブは読み直す。※ iOS のホーム画面版と Safari 版は保存領域が別なので、互いのデータは見えない（§8） |
| Service Worker | アプリ本体のキャッシュだけを扱い、IndexedDB に触らない |
| GitHub 側での手編集・別端末からの書き込み | 端末へは自動で取り込まない。次の保存で sha が合わなくなったときに §4 の衝突として扱う（I7） |
| 試験用の入口 | `repo`・関所・`backup` を `fake-indexeddb` と差し替えた `fetch` の上で直接呼ぶ。本番コードに試験専用の書き込み口は作らない |
| 変更の能力の持ち出し | `repo`・関所は DB ハンドルやトランザクションを外へ返さない（戻り値は値のコピーだけ）。`idb` の `openDB` を呼ぶのは `src/data/db.ts` の 1 か所だけ。`meta.backup` を put するのは `lineage.ts` だけ。grep で見張る（§9） |

## 4. GitHub 自動保存

### 4.0 エラーの種類と再試行

表示状態は §2.2 の規則で導出する。エラーの種類 `errorKind` だけを保存する。

| errorKind | 付く条件 | 自動再試行 | 消える条件 |
|---|---|---|---|
| `network` | ネット不通・タイムアウト（15 秒）・5xx | 次のきっかけで再試行 | 送信成功・照合成功 |
| `rate-limit` | §4.1 の rate limit 判定 | `retryAfter` を過ぎた後のきっかけで再試行 | 同上 |
| `auth` | 401、rate limit でない 403 | 止める | `saveConfig`（トークンの再設定） |
| `config` | 404（リポジトリが無い・権限が無い） | 止める | `saveConfig` |
| `conflict` | §4.2 の「自分の写しでない」 | 止める | 衝突の解決（§4.3）・復元 |
| `invalid` | sha 衝突でない 422、GET した内容の形式違い | 止める | `saveConfig`・衝突の解決・復元 |

**送信のきっかけ**: 端末での変更の 3 秒後（連続した変更はまとめる）／起動時／画面が前面に戻ったとき／`online` イベント／`saveConfig` の後／設定画面の「今すぐ保存」。止める種類のエラーがあるときは、ユーザー操作（設定の保存・今すぐ保存・衝突の解決）以外のきっかけでは送らない。「今すぐ保存」は Web Lock 内で関所 `clearErrorForRetry(generation)` を呼んで `errorKind`・`retryAfter` を消してから送る（`pendingPush` は触らない。残っていれば照合から始まる）。

### 4.1 GitHub Contents API の契約

- 共通ヘッダ: `Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`、`Authorization: Bearer <token>`。宛先は `https://api.github.com/repos/{owner}/{repo}/contents/{path}` だけ
- GET: `?ref={branch}`。応答の `sha`（blob sha）と `content`（base64）を使う。`encoding` が `base64` でない・`type` が `file` でないときは `invalid`
- PUT: 本文 `{ message, content: base64(本文バイト列), branch, sha? }`。成功（200／201）で次回に使うのは **`content.sha`（blob sha）**。`commit.sha` は使わない
- 状態コードの分類（GET・PUT 共通）:
  - 200／201 → 成功
  - 401 → `auth`
  - 403 → `X-RateLimit-Remaining: 0` または `Retry-After` があれば `rate-limit`（`retryAfter` = `Retry-After` 秒後、無ければ `X-RateLimit-Reset`）、それ以外は `auth`
  - 429 → `rate-limit`（同上）
  - 404 → GET では「ファイルが無い」（`config` かどうかは呼び出し側で決める。下記）、PUT では `config`
  - 409 → PUT の sha 衝突の候補
  - 422 → PUT の sha 衝突の候補。直後の GET で「ファイルが存在し、その sha が送った sha と違う（または sha を送っていない）」ときだけ sha 衝突。GET の sha が送った sha と同じなら一般の 422 として `invalid`
  - 5xx・ネット不通・タイムアウト → `network`
- GET の 404 の扱い: リポジトリ自体が無い・見えない場合も GitHub は 404 を返すので、ファイルの有無と区別できない。「ファイルが無い」と読んでよいのは §4.2 で明記した箇所だけで、その後の PUT が 404 なら `config` になる
- CORS: GitHub REST API は任意の origin からの CORS に対応し、preflight で `Authorization` ヘッダと `PUT` を許可している（公式ドキュメントで 2026-09-30 確認）

### 4.2 1 回の送信（`backup.push`）

1. Web Lock `kome-backup` を取る（取れなければ、実行中の処理に任せて終わる）
2. 系譜を読む（= L）。`config` が null、止める種類の `errorKind` がある、`retryAfter` が未来、`needsPush` が偽 → 10 へ
3. **残った `pendingPush` の照合**（L.`pendingPush` があるとき。前回の送信が、届いたかどうか分からないまま終わった）: GET する
   - GET が成功し、本文の SHA-256 = `pendingPush.bodySha256` → 届いていた。関所 `recordPushLanded(L.generation, writeId, GET の sha)`
   - GET が成功し、sha = L.`lastPushedSha` → 届いていなかった。関所 `clearPending(L.generation, writeId)`
   - GET が 404 で L.`lastPushedSha` が null → 届いていなかった（新規ファイルの作成が失敗）。関所 `clearPending`
   - GET が成功したがどちらでもない、または 404 で L.`lastPushedSha` が null でない → 関所 `recordPushError(L.generation, pendingPush.writeId, 'conflict', keepPending: false)` で `pendingPush` を消して 10 へ
   - GET が失敗（`network`・`rate-limit`・`auth`）→ 関所 `recordPushError(L.generation, pendingPush.writeId, 種類, keepPending: true)`。**`pendingPush` は残す**（照合できていないため）。10 へ
   - 系譜を読み直して L とし、2 へ戻る（関所が世代違いで何も書かなかった場合も、読み直しで検出される）
4. 1 つの読み取りトランザクションで `dataRevision`（= R）と `receipts` 全件を読む。トランザクションを閉じてから、新しい `writeId` で §2.1 の本文を作り、SHA-256 を計算する
5. 関所 `beginPush(L.generation, { writeId, revision: R, bodySha256 })` で `pendingPush` を確定する（**PUT より前**）。世代が変わっていて書けなければ 2 へ戻る
6. PUT（`message: "kome: rev R（N件・累計 Xkg）"`、`sha: L.lastPushedSha`（null なら省く））
7. 応答で分ける（どの記録も、関所に世代と `writeId` を渡す。一致しなければ関所は何も書かない＝I14）:
   - 成功 → `recordPushLanded(generation, writeId, content.sha)`
   - sha 衝突の候補（409・422）→ GET する（PUT は拒否されたので、ここから先は `pendingPush` を消してよい）
     - GET 成功・本文の SHA-256 = `bodySha256` → `recordPushLanded(generation, writeId, GET の sha)`（再送が先に届いていた場合）
     - GET 成功・422 で sha = 送った sha → `recordPushError(generation, writeId, 'invalid', keepPending: false)`
     - GET 成功・それ以外 → `recordPushError(generation, writeId, 'conflict', keepPending: false)`
     - GET 404・送った sha が null でない → 関所 `resetRemote(generation, writeId)`（`lastPushedSha = null`、`pendingPush = null`）にし、系譜を読み直して 4 へ 1 回だけ戻る（sha を省いた新規作成になる）。2 回目も同じなら `conflict`
     - GET 404・送った sha が null → `recordPushError(generation, writeId, 'invalid', keepPending: false)`（ファイルが無いのに作成が拒否された）
     - GET 失敗（`network`・`rate-limit`・`auth`）→ `recordPushError(generation, writeId, 種類, keepPending: false)`、`pendingPush` を消す（PUT が拒否されたことは確かなため）。成功・`conflict` へは進まない
   - `network`・`rate-limit` → `recordPushError(generation, writeId, 種類, keepPending: true)`。**`pendingPush` は残す**（届いたかどうか分からない。次回の手順 3 で照合する）
   - `auth`・`config`・一般の `invalid` → `recordPushError(generation, writeId, 種類, keepPending: false)`、`pendingPush` を消す（届いていないことが確かなため）
8. 送信中に端末が変わっていれば、`lastPushedRevision = R` なので `needsPush` が残る
9. `needsPush` が残り、エラーが無ければ 2 へ戻る（1 回の送信につき最大 5 周。超えたらエラーを書かずに止める。`needsPush` が残るので次のきっかけで再開する。この止め方は `writeId` を持たないため、関所へ書かない）
10. ロックを外す

### 4.3 衝突の解決（ユーザー操作）

`conflict` のとき、ホームと設定に「GitHub 側に、この端末が送っていないデータがあります」と出し、GET した内容の件数・累計 kg・最終受取日と、端末の同じ値を並べて見せる。

- 「端末の内容で上書き」: Web Lock 内で GET の sha を取り直し、関所 `adoptRemoteSha(generation, sha)`（`lastPushedSha = sha`、`errorKind = null`、`pendingPush = null`、`lastPushedRevision` はそのまま）→ §4.2 の 2 から送る。確認画面に「上書き前の内容は GitHub の履歴に残る」ことを書く
- 「GitHub から復元」: §6.1 の復元手順へ

### 4.4 系譜の関所（`src/backup/lineage.ts`）

`meta.backup` を書くのはこの関所だけ（I14）。どの操作も 1 つの readwrite トランザクションで、まず今の系譜を読み、**呼び出し側が渡した世代（`generation`）と一致するか**、送信の結果なら **`pendingPush.writeId` とも一致するか** を確かめる。一致しなければ何も書かず「古い」を返す（呼び出し側は系譜を読み直す）。

| 操作 | 前提の確認 | 書く内容 | 呼ぶ者 |
|---|---|---|---|
| `saveConfig(expectedGeneration, config, token?)` | Web Lock 内。世代の一致 | 保存先が変わった（または null から設定した）: 新しい `generation`、`lastPushedSha = null`、`lastPushedRevision = null`、`pendingPush = null`、`errorKind = null`、`retryAfter = null`、トークン。**トークンだけ**の変更: 系譜はそのまま、トークンを書き、`errorKind` が `auth`／`config` なら消す | 設定画面 |
| `beginPush(gen, pending)` | 世代の一致、`pendingPush` が null | `pendingPush` | §4.2 手順 5 |
| `recordPushLanded(gen, writeId, sha)` | 世代と `writeId` の一致 | `lastPushedSha = sha`、`lastPushedRevision = max(現在値 ?? -1, pendingPush.revision)`、`lastPushedAt`、`pendingPush = null`、`errorKind = null`、`retryAfter = null` | §4.2 手順 3・7 |
| `clearPending(gen, writeId)` | 世代と `writeId` の一致 | `pendingPush = null` | §4.2 手順 3 |
| `resetRemote(gen, writeId)` | 世代と `writeId` の一致 | `lastPushedSha = null`、`pendingPush = null` | §4.2 手順 7 |
| `recordPushError(gen, writeId, kind, keepPending, retryAfter?)` | 世代の一致、かつ `pendingPush?.writeId === writeId`（照合・送信の結果に限る。`writeId` を持たないエラー操作は置かない） | `errorKind`、`retryAfter`、`lastErrorMessage`、`keepPending` が偽なら `pendingPush = null` | §4.2 |
| `clearErrorForRetry(gen)` | Web Lock 内。世代の一致 | `errorKind = null`、`retryAfter = null`（`pendingPush`・sha・revision は触らない） | 「今すぐ保存」（§4.0） |
| `adoptRemoteSha(gen, sha)` | Web Lock 内。世代の一致 | `lastPushedSha = sha`、`pendingPush = null`、`errorKind = null`、`retryAfter = null` | §4.3 |
| `restore(expected, backup, source)` | Web Lock 内。世代の一致、`dataRevision` = 確認時の D0 | §6.1 手順 3 のとおり（記録の全件入れ替えを含む） | §6.1 |
| `undoRestore(gen)` | Web Lock 内。世代の一致、`preRestoreSnapshot` がある | 記録を戻し、スナップショットを消し、`dataRevision` +1、`pendingPush = null`、`errorKind = null`、`retryAfter = null`（系譜の sha・revision はそのまま → `needsPush` になり、次の送信で GitHub も取り消し後の内容になる。取り消し前の GitHub の内容は git の履歴に残る） | 設定画面 |

## 5. 失敗・中断の地点ごとの表

| 落ちた／失敗した地点 | 端末・GitHub に残るもの | 次の起動・再試行での動き | 結果 |
|---|---|---|---|
| 記録の書き込みトランザクションの確定前 | 何も変わらない（IndexedDB が丸ごと取り消す） | 入力画面にエラーを出し、入力内容は画面に残す（アプリごと落ちたら入力は失われる） | 半端な記録は残らない（I1・I3） |
| 記録の確定後・送信の予約前 | 記録と +1 された `dataRevision`（→ `needsPush`） | 起動時に送信 | 送り漏れない。「保存済み」と誤表示しない |
| 新しい保存先を設定した直後（記録 0 件・`dataRevision` 0 を含む） | `lastPushedRevision = null`（→ `needsPush`） | 新しい保存先へ全件（0 件なら空の写し）を送る。既にファイルがあれば sha を省いた PUT が拒否され `conflict` | 初回送信が漏れない。既存ファイルを確認なしに上書きしない（P1-1） |
| 写しを作る途中 | 端末は変わらない | 次のきっかけで最初から | 影響なし |
| `pendingPush` の確定後・PUT を送る前 | `pendingPush`（GitHub は旧版のまま） | 手順 3: GET の sha が `lastPushedSha` と一致（または 404 で `lastPushedSha` が null）→ 届いていない → `clearPending` → 送り直す | 影響なし |
| PUT が GitHub で確定したが、応答を受け取る前に落ちた | GitHub: 新しい写し。端末: `pendingPush` が残る | 手順 3: GET 本文のハッシュが一致 → `recordPushLanded`。重複コミットを作らない | 冪等 |
| 応答は受け取ったが、関所の確定前に落ちた | 上と同じ | 上と同じ | 上と同じ |
| PUT の応答待ちの間に保存先を変更した | 新しい世代の系譜。旧 PUT は旧保存先に届いたかもしれない | 旧 PUT の結果は世代違いで関所が捨てる。新しい保存先へは `needsPush` で全件を送る | 旧応答が新しい系譜に入らない（P1-2・I14） |
| ネット不通・タイムアウト・rate limit | `pendingPush` が残る | 次のきっかけで手順 3 の照合から | 届いていても届いていなくても照合で確定できる |
| 照合の GET が失敗（ネット不通・rate limit・401／403） | `pendingPush` が残る、`errorKind` | ネット系は次のきっかけで照合から。`auth` は再設定の後に照合から | 照合できないまま成功・`conflict` にしない（P2-1） |
| sha 衝突後の GET が失敗 | `pendingPush` は消える（PUT は拒否されていた）、`errorKind` | ネット系は次のきっかけで送信から | 成功・`conflict` にしない |
| トークン期限切れ・取り消し（401／403） | `pendingPush` は消える（PUT の場合）、`needsPush` のまま | `auth`。ホームと設定に「トークンを再設定してください」 | 再設定まで保存が止まることを表示で知らせる |
| 復元の検証中にエラー | 端末は変わらない | 理由を表示 | 1 件も適用しない（I9） |
| 復元の確認画面を出したあと、別タブで記録・設定が変わった／GitHub が変わった | 端末・GitHub は変わったまま | 確定時の再確認で不一致 → 置き換えずに再プレビューへ戻る | 古い確認で置き換えない（I8） |
| 復元トランザクションの確定前に落ちた | 端末は復元前のまま（丸ごと取り消し） | もう一度復元できる | 半端な入れ替えにならない（I8） |
| ネット不通で `pendingPush` が残ったまま JSON から復元した | 復元で `pendingPush` が消え、`needsPush` | 復元後のデータを新しい送信として送る | 復元前の送信結果を復元後の保存実績にしない（P1-3） |
| GitHub から復元した後 | 新しいデータ、`preRestoreSnapshot`、`lastPushedSha = S0`、`lastPushedRevision = D0 + 1` | 保存済み。次の変更から通常どおり送る | 取り消しは `undoRestore` で可能 |
| Service Worker の更新途中 | 旧版のアプリ本体がキャッシュに残る | 次回の起動・前面復帰で更新を再確認 | データに影響なし |
| DB の版上げ（将来）の途中で落ちた | IndexedDB の版上げは 1 トランザクションなので旧版のまま | 次の起動で版上げをやり直す | 半端な移行にならない |
| 新しい DB を古いアプリで開いた | 何も変わらない | 停止モード。アプリの更新を取りに行く | 書かない（I13） |

## 6. 起動時・再開時の手順

1. `openDB('kome', KNOWN_DB_VERSION)` で開く。`VersionError` なら停止モード（I13）: 「新しい版のアプリで作られたデータです。アプリを更新してください」を出し、`registration.update()` を呼び、以降の手順を行わない
2. 初めてなら `meta.app` を `{ schemaVersion: 1, deviceId: 新しい UUID, dataRevision: 0 }` で、`meta.backup` を §2.2 の初期値で作る（1 トランザクション）
3. `meta.app.schemaVersion` がアプリの知っている版より大きい → 停止モード（手順 1 と同じ）
4. `navigator.storage.persist()` を要求。ホーム画面から起動していない（`display-mode: standalone` でない）ときは追加を促す
5. 自動アップデートを準備（Libroli の方式: `controllerchange` で再読み込みを予約し、I11 の条件を満たしたら実行。前面復帰・フォーカス時と 1 時間ごとに `registration.update()`）
6. 画面を描く（記録を読んで計算。GitHub の結果を待たない）
7. 裏で `backup.push()`（手順 3 の照合を含む。画面の描画を待たせない）
8. 知らない `errorKind` の値に出会ったら `null` として扱う

### 6.1 復元（GitHub から／JSON ファイルから）

1. **取得と検証**: GitHub なら GET（本文と blob sha）、ファイルならファイル読み込み。`validateBackup` を通す。通らなければ理由を出して終わり（I9）。GET の失敗は §4.1 の分類で表示して終わり
2. **確認**: 端末の件数・累計 kg・最終受取日と、バックアップの同じ値を並べて見せる。このときの端末 `dataRevision`（= D0）、系譜の世代（= G0）、GitHub の blob sha（= S0。ファイルからの復元なら無し）を控える。確認文:
   - 「端末の N 件を、バックアップの M 件で置き換えます。置き換え前の端末の内容は、この端末の中に 1 つだけ残り、取り消せます」
   - GitHub からの復元では追加で「復元後は、この端末がこのバックアップを引き継いで GitHub を更新します」
3. **確定**: 「置き換える」を押したら Web Lock `kome-backup` を取り、ロックの中で:
   1. GitHub からの復元なら、GET し直して sha が S0 と同じか確かめる。違えば手順 1 へ戻る。GET が失敗したら置き換えずに終わる
   2. 関所 `restore({ D0, G0, S0 }, backup, source)` を呼ぶ。1 つの readwrite トランザクションで `dataRevision = D0` かつ世代 = G0 を確かめ（違えば中止して手順 1 へ戻る）、同じトランザクションで:
      - `preRestoreSnapshot` = 現在の全件と D0／`receipts` 全削除 → 全件追加／`dataRevision = D0 + 1`
      - 系譜（どちらの復元でも）: `pendingPush = null`、`errorKind = null`、`retryAfter = null`
      - GitHub からの復元: さらに `lastPushedSha = S0`、`lastPushedRevision = D0 + 1`（GitHub と端末が同じ内容なので保存済み）
      - JSON ファイルからの復元: `lastPushedSha`・`lastPushedRevision` はそのまま（→ `needsPush`。次の送信で GitHub へ送る。GitHub の sha が一致しなければ通常どおり `conflict`）
4. ロックを外し、`BroadcastChannel` で他タブへ知らせる

機種変更のときは、設定画面でトークンとリポジトリ名を入れる（→ 新しい世代、`lastPushedRevision = null`）。案内より先に自動送信が走っても、保存先に既にファイルがあれば sha を省いた PUT が拒否されて `conflict` で止まり、空の写しで上書きしない（I7）。`conflict` の画面と設定画面から「GitHub から復元」を選べる。端末の記録が 0 件で `conflict` になったときは、復元を第一の選択肢として出す。

## 7. 並行・順序

- **端末内の書き込み**: IndexedDB が readwrite トランザクションを直列化する。`dataRevision` の +1 は読み取りと書き込みを同じトランザクションで行うので、同時に 2 つ来ても番号が飛んだり重なったりしない
- **GitHub への送信・復元・設定の保存・衝突の解決**: どれも Web Lock `kome-backup` を取ってから行う。同時に 1 つだけ
- **ロックをすり抜けた古い結果**: Web Lock が効かない場合（ロックの外で走った古いタブの処理など）に備え、系譜の書き換えは関所で世代と `writeId` を比べる（I14）。ロックと関所の二重の守り
- **送信中に端末が変わる**: `lastPushedRevision = R`（送ったときの番号）にするので `needsPush` が残り、送り直す（I6）
- **復元の確認中に別タブで変更**: 確定時に D0・G0 と比べて検出し、置き換えない（§6.1 手順 3）
- **await をまたぐ読み取り**: 写しは 1 つの読み取りトランザクション（`dataRevision` と全件）から作る。IndexedDB のトランザクションは、中で fetch や SHA-256 の計算を待つと自動で閉じるので、トランザクションの中でそれらを待たない（読み終えてから計算・通信する）。関所の各操作も、トランザクションの中では IndexedDB の読み書きだけを行う
- **複数タブ**: 変更後に `BroadcastChannel` で知らせ、他タブは読み直す。DB の版上げは `versionchange` で古いタブが閉じる
- **再入**: `repo` の関数の中から `backup.push` を直接呼ばない（送信は「予約」だけ。トランザクションの外で走らせる）。`backup.push` の中から `repo` の書き込み関数を呼ばない。関所の操作の中から他の関所の操作・`backup.push` を呼ばない。Web Lock を持っている処理の中で、もう一度 Web Lock を取らない（関所の `saveConfig`・`restore` 等は、ロックを持つ呼び出し側の中で呼ぶ）

## 8. 既知の限界・後回し

- iOS のホーム画面版と Safari 版は保存領域が別。Safari で記録した分はホーム画面版に出ない → Safari で開いたときに追加を促す表示で対処
- トークンは端末内に平文で置く（Web で安全に隠す手段は無い）。被害を狭めるため、**Fine-grained PAT で `kome-data` 1 つだけ・Contents の読み書きだけ** に絞る。外部スクリプトを読み込まない。`Content-Security-Policy` を meta で `default-src 'self'; connect-src 'self' https://api.github.com` にする
- 確認済み（公式ドキュメント、2026-09-30）:
  - GitHub REST API は任意の origin からの CORS に対応し、preflight で `Authorization` と `PUT` を許可している
  - Fine-grained PAT は無期限も選べる（組織・Enterprise のポリシーで上限を課される場合がある。個人リポジトリなので対象外の見込み）。期限を付けた場合の期限切れは `auth` で知らせる
- 成立性確認の結果（2026-10-01、`spike/`・往復ログ参照）:
  - GitHub Contents API（`kome-data` で実施、試験ファイルは削除済み）: GET 404（空リポジトリ・ファイル無し・リポジトリ無しのいずれも 404）／sha なし PUT で新規作成（応答の `content.sha` が次の GET の `sha` と一致）／GET の `content` を base64 で戻したバイト列の SHA-256 が送った本文と一致／sha 付き PUT で更新／古い sha の PUT は **409**／sha なしで既存ファイルへの PUT は **422**（`"sha" wasn't supplied`）。§4.1・§4.2 の前提どおり
  - CORS（`Origin` 付きの preflight を再現）: `access-control-allow-origin: *`、許可ヘッダに `Authorization`・`Content-Type`・`X-GitHub-Api-Version`、許可メソッドに `PUT`、公開ヘッダに `Retry-After`・`X-RateLimit-Remaining`・`X-RateLimit-Reset`。API の確認は `gh` の既存ログイン（CLI）で行い、ブラウザ上で PAT を使った通しの確認は、ユーザーが PAT を発行した後の最初の結合確認で行う
  - `.ics`（iOS シミュレータ iPhone 17 Pro・iOS 26.5、ホーム画面に追加した版で `display-mode: standalone` を確認）: **Blob を `<a download>` でダウンロードさせる方式で、カレンダーの追加画面が直接開き、終日の予定と「3 日前」の通知が読み込まれた**。この方式を採用する（実機は未確認。初回の実機利用で確かめる）
- GET の 404 はリポジトリが見えない場合とファイルが無い場合を区別できない（§4.1）。「ファイルが無い」と読むのは §4.2 の限られた箇所だけで、続く PUT の 404 で `config` として表面化する
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

試験は Vitest ＋ `fake-indexeddb`、GitHub は `fetch` の差し替えで決定的に行う（送信の途中で止める試験は、差し替えた `fetch` の中の barrier で止め、合図を受けてから次の操作を呼ぶ）。結果の列は実装後に埋める。U1 の結果: commit `c0fe80b`、`tsc --noEmit` 指摘なし、Vitest 48/48、mutation 12 通りすべて検出（壊した実装は `git checkout` で戻した）。U1 実装検収（2026-10-01、P1×2・P2×1）の修正後: Vitest 60/60、追加の mutation N1〜N4 を検出（下表）。N5（時差の範囲チェックを外す）は検出されず、`Date.parse` が既に拒むため効いていない重複と判断してコードから外した。

| 不変条件 | 試験（予定） | 壊して確かめたこと（mutation） |
|---|---|---|
| I1 | U1（`tests/repo.test.ts`「I1」）: DB を閉じて書けない状態で追加 → `failed` を返し、記録も `dataRevision` も残らない。入力値を画面に残すのは U3 の画面の試験で確かめる。確定した後の通知（`onChange`）が例外を出しても、追加・編集・削除は成功を返し、通知の失敗は `console.error` に分ける | M5 追加の失敗を成功として返す → I1・I3 の 2 件が落ちた。N1 通知の失敗を投げ直す → 1 件が落ちた |
| I2 | U1（`tests/validate.test.ts`・`tests/repo.test.ts`「I2」）: 不正な値 17 通り＋オブジェクトでない値を `validateReceipt` が拒否。追加・編集の経路でも `invalid` を返し DB が変わらない。復元の経路は U2 で足す。0.1 kg 刻みで 10 倍した整数が 1 以上であること（`1e-11` など 0 に丸められる値を拒否）、日時は日付の実在（2/30・平年の 2/29・13 月）と時（24 時）を自前で確かめる | M2 未来日の検査を外す → 3 件、M3 小数 1 桁の検査を外す → 2 件、M4 `updatedAt < createdAt` の検査を外す → 1 件が落ちた。N2 0 に丸められる量を通す → 2 件、N3 日付の実在を確かめない → 2 件、N4 時の範囲を確かめない → 1 件が落ちた |
| I3 | U1（`tests/repo.test.ts`「I3」）: `dataRevision` を上げた後で記録の追加を失敗させる（ID の衝突）→ 両方とも元のまま。無い記録の編集・削除は `not-found` で `dataRevision` 不変。「保存待ち」の表示は U2（`needsPush`）で足す | M1 `dataRevision` を別のトランザクションで上げる → I3 を含む 7 件が落ちた |
| I4 | U1（`tests/repo.test.ts`「I4」）: 書き込み後も `meta.app` は 3 項目・記録は 7 項目だけ（累計・予測を保存していない） | 保存を足すと形の照合で落ちる（この形の試験自体の mutation は行っていない） |
| I5 | 送信する本文が全件を含み、`validateBackup` を通る。0 件でも `receipts: []` の写しを送る | |
| I6 | 送信中（PUT の応答待ちで止める）に記録を足すと、送信後に `needsPush` が残って送り直す。同じ世代で `lastPushedRevision` は減らない | |
| 初回送信 | (a) 記録 0 件・`dataRevision` 0 で空の新しい保存先を設定 → 空の写しが 1 回送られ「保存済み」になる。(b) 既にファイルがある保存先を設定 → PUT 拒否 → `conflict`、既存ファイルは変わらず、復元の案内が出る | |
| I7-a | GitHub 上が手編集された JSON（`deviceId`・`revision` は端末と同じ、本文は違う）のとき、PUT を送らず `conflict` になる | |
| I7-b | `pendingPush` 確定後・PUT 前で落とす → 次回の照合で届いていないと判定して送り直す（コミットは 1 つ） | |
| I7-c | PUT 確定後・応答前で落とす → 次回の照合で自分の写しと判定し、GET の sha を記録する（重複コミットを作らない） | |
| I7-d | ネット不通で失敗 → `pendingPush` が残り、次回は照合から始まる | |
| 照合の GET 失敗（P2-1） | 照合の GET がネット不通／429／401 → `pendingPush` が残り、成功・`conflict` にならない。sha 衝突後の GET がネット不通 → `pendingPush` は消え、成功・`conflict` にならない | |
| I14・保存先変更の並行（P1-2） | PUT の応答待ちで止めた状態で保存先を A→B に変える → 旧 PUT の成功応答を流しても B の系譜（`lastPushedSha`・`lastPushedRevision`）は変わらず、B へ全件が送られる。トークンだけの変更では世代が変わらない | |
| I14・同じ世代の古い送信（改訂 3 P1-1） | 同じ世代で送信 A の `pendingPush` を消した後に送信 B の `pendingPush` を確定し、A の writeId で `recordPushError`（network／auth／conflict）と `recordPushLanded` を流す → B の `pendingPush`・`errorKind`・sha・revision が変わらない | |
| 今すぐ保存（改訂 3 P2-1） | `auth` で止まった状態で今すぐ保存 → `clearErrorForRetry` でエラーが消えて送信が走る。古い世代を渡した `clearErrorForRetry` は何も書かない | |
| I14 の経路 | grep: `meta` の `backup` キーへの put、`secrets`・`preRestoreSnapshot` への書き込みが `src/backup/lineage.ts` だけ（全出現を許可リストと照合） | |
| I8 | 確認後に別タブで記録を足す → 確定で置き換えず再確認へ。確認後に保存先を変える → 同上。確認後に GitHub の sha が変わる → 同上。復元トランザクションの途中で例外 → 端末は元のまま。確定後 `undoRestore` で完全に戻る。GitHub から復元した直後は「保存済み」で、次の変更の PUT が S0 を sha にして成功する | |
| JSON 復元と残った pending（P1-3） | ネット不通で `pendingPush` が残った状態で JSON から復元 → `pendingPush` が消え、次の送信は復元後のデータを新しい `writeId` で送る。旧 pending 本文が GitHub に届いていても、復元後のデータが保存済み扱いにならない | |
| I9 | `schemaVersion: 2`、`format` 違い、`receipts` が配列でない、`revision` が負・小数、`deviceId`・`writeId` が UUID でない、`exportedAt` が不正、1 件だけ不正な記録、`id` の重複の各バックアップで 1 件も適用されない | |
| I10 | 書き出し JSON・送信本文・エラー文言にトークン文字列が含まれない。`fetch` の宛先が `api.github.com` だけ | |
| I11 | 入力欄にフォーカス中・フォームが未保存・ダイアログ表示中は再読み込みしない。解除後に再読み込みする | |
| I12 | U1（`tests/stats.test.ts`）: 0 件・1 件・同日 2 件は予測しない（残り回数つき）、サンプル 8 件で 10/29・あと 28 日・約 39 日おき、境界（8 日＝ahead／7 日＝soon／当日＝today／−3＝overdue）、直近 7 日分だけ使う、kg を 0.1 刻みの整数で足す。日付ごとに合算するので「受取日 2 日以上」なら span は必ず 1 以上（span 0 の分岐は持たない）。検証を通った最小の量（0.1 kg）を含む記録でも予測が例外を出さない | M6 受取日 1 日でも予測 → 1 件、M7 窓を広げる → 2 件、M8 kg を小数のまま足す → 1 件、M12 7 日の境界をずらす → 1 件が落ちた |
| I13 | U1（`tests/repo.test.ts`「I13」）: 版 2 の DB を版 1 で開く → `newer-db-version`、DB の版・store・中身が変わらない。`schemaVersion: 2` → `newer-schema`、`meta.app` 不変・系譜も作らない | M9 `VersionError` を捕まえない → 1 件、M10 `schemaVersion` を確かめない → 1 件が落ちた |
| §4.1 の契約 | 送るヘッダ・`ref`・PUT の本文の形を固定。応答の `content.sha` を記録し `commit.sha` を記録しない。403（rate limit ヘッダあり／なし）・429・404・一般の 422・sha 不一致の 422・409 の各分類 | |
| §3 の経路 | U1（`tests/static.test.ts`）: IndexedDB を開くのは `db.ts` だけ、`meta.backup` の put は `lineage.ts` だけ、`meta.app` の put は `db.ts`・`repo.ts` だけ、記録の store は `repo.ts` だけ、`fetch` は無い（全出現を許可リストと照合）。検索式は型引数つき（`openDB<…>(`）・入れ子の括弧つきの呼び出しも拾う形にした（初版の式はこの 2 つを見落とし、試験が赤になって気づいた）。`api.github.com` の照合は U2 で足す | M11 別ファイルから `indexedDB.open` → 1 件が落ちた |
