# ExperiPhoto

実験中に携帯で撮った写真を、プロジェクトを選んで Dropbox の「受け箱」へ送る Web アプリ（PWA）。
Mac の Research Hub がその受け箱を読み、実験ノート（Obsidian の md）に貼る。

```
携帯（ExperiPhoto）── 撮る → Dropbox: アプリ/ExperiPhoto…/受け箱/<プロジェクト>/ ── Research Hub（Mac）で選んで貼る
                    ← projects.json（プロジェクトと最近の実験ノート）←────────────────── Research Hub が置く
```

- 撮る前に、プロジェクト・実験ノート（任意）・メモ（任意。写真の名前に入る）を選ぶ。選んだものは覚えておく。
- 写真の名前は `20261126-142305 WBサンプル.jpg`（撮った時刻＋メモ）。実験ノートを選んだときは、横に `…jpg.json`（どのノート向けか）を置く。
- 撮ったあと、切り取り・90° 回転・撮り直しができる（設定で切れる）。何も変えなければ、元の写真をそのまま送る。切り取ったときだけ JPEG（画質 95%）に保存し直す。
- 電波が無くても撮れる。写真は携帯の中（IndexedDB）に溜まり、つながったら送る。
- ふだんは原寸で送る（ブロットやゲルの細部を残すため）。設定で「縮小して送る（長辺 2048px）」にできる。
- サーバーは無い。静的なファイルだけで、Dropbox とは携帯のブラウザが直接やり取りする。

## Dropbox の許可

Dropbox のアプリは **App folder 型**。このアプリが読み書きできるのは `Dropbox/アプリ/<アプリ名>/`（英語版は `Apps/`）の中だけで、ほかのファイルは見えない。
ログインは PKCE（ブラウザ用の手順）で、App secret は使わない。携帯に残るのは、このフォルダー用の更新トークンだけ。

## 初めに一度だけ（Dropbox のアプリを作る）

1. <https://www.dropbox.com/developers/apps> で「Create app」。
2. 「Scoped access」→「App folder」。名前は **ExperiPhoto で始める**（Research Hub はこの名前でフォルダーを探す。Dropbox 全体で重ならない名前にする。例：`ExperiPhoto-lab`）。
3. **Permissions** のタブで `files.content.write` と `files.content.read` に印を付けて「Submit」。（携帯でつなぐ**前に**する。後から足した許可は、つなぎ直すまで効かない）
4. **Settings** のタブ：
   - 「OAuth 2 → Redirect URIs」に、このアプリを置く URL を足す（例：`https://<GitHub のユーザー名>.github.io/experiphoto/`。最後の `/` まで同じに）。手元で試すなら `http://localhost:8790/` も。
   - 「Allow public clients (Implicit Grant & PKCE)」は Allow のまま。
   - 「App key」を `config.js` の `DROPBOX_APP_KEY` に書く（App key は秘密ではない。**App secret は書かない**）。

## 置き場所（GitHub Pages）

静的なファイルなので、そのまま GitHub Pages に置ける（Settings → Pages → Branch: `main` / `/(root)`）。
直したら `sw.js` の `VERSION` を上げる（携帯が古い画面を持ち続けないように）。

## 携帯で使う

1. Android の Chrome で置いた URL を開き、「Dropbox につなぐ」。Dropbox の画面で許可する。
2. Chrome のメニューから「ホーム画面に追加」（アプリとして開ける）。
3. Mac の Research Hub を開くと `projects.json` が置かれ、携帯の ↻ でプロジェクトが出る。

## お試し・手元で動かす

```bash
python3 -m http.server 8790 --bind 127.0.0.1
```

`http://localhost:8790/?demo=1` で「お試し」になる（Dropbox には送らず、見本のプロジェクトで動く。`?demo=0` で終わる）。

## ファイル

| ファイル | 中身 |
| --- | --- |
| `index.html`・`style.css` | 画面 |
| `app.js` | 選ぶ・撮る・送る・送った一覧 |
| `dropbox.js` | Dropbox とのやり取り（PKCE、アップロード、お試し） |
| `queue.js` | 送る前の写真を溜める IndexedDB |
| `exif.js` | 写真の中の記録（EXIF）から撮った日時を読む |
| `review.js` | 撮ったあとの確認（切り取り・回転・撮り直し） |
| `config.js` | Dropbox の App key |
| `sw.js`・`manifest.webmanifest`・`icons/` | ホーム画面に置くための部品（`tools/make-icon.py` でアイコンを描く） |

## 受け箱の取り決め（Research Hub と合わせる）

| 場所 | 書くもの | 中身 |
| --- | --- | --- |
| `/projects.json` | Research Hub | `{ v: 1, projects: [{ id, name, color, experiments: [{ title, path, created, status }] }] }` |
| `/受け箱/<プロジェクトの id>/<YYYYMMDD-HHmmss>[ メモ].<拡張子>` | 携帯 | 写真。名前が重なると Dropbox が ` (1)` を足す |
| `/受け箱/<プロジェクトの id>/<写真の名前>.json` | 携帯 | `{ v: 1, project, experiment: { title, path }, memo, takenAt, name }`（実験ノートを選んだときだけ） |
| `/使わない/<プロジェクトの id>/…` | Research Hub | 「使わない」にした写真（消さずに移す） |
