# rurupop-updater（RuruPop 更新ツール）

- 作成者：ネロ　作成日：2026-11-25　状態：【準備完了・未デプロイ】（議題044）
- URL：https://update.rurupop.com/（Cloudflare Access：るるのGoogleアカウントのみ）

## 何をするツールか

1. 更新先を選ぶ → 2. 受け取ったZIPを選ぶ → 3. 内容を確認する → 4. 反映する → 結果（公開完了／失敗）を確認する

裏側では、ZIPを開いて中身を確認し、GitHubのリポジトリに1回の記録（コミット）として書き込みます。そのリポジトリにつながったCloudflareの自動デプロイ（Workers Builds）が、サイトを公開し直します。

## 安全のための仕組み

| 仕組み | 内容 |
|---|---|
| 入口 | Cloudflare Access のGoogleログイン。Worker側でもAccessのトークンを検証し、なければ何もしない |
| 取り違え防止 | ZIPの `update.json` の `target` と、選んだ更新先が一致しないと反映できない。確認画面に更新先を色付きで大きく表示し、ボタンにも更新先の名前を出す |
| 変更できる範囲 | 更新先ごとに、変更してよいファイルの場所を決めておく（例：fates-beta は `scenarios/*.txt` だけ）。範囲外のファイルが1つでもあれば反映しない |
| 事前の検証 | 更新先ごとの検証（fates-beta：台本記法v0.2の全ルート検証） |
| 確認と実行の一致 | 確認したZIPと実行するZIPが同じかを照合する |
| 同時更新 | 確認中に別の更新が入っていたら、上書きせずに失敗させる |
| 失敗の表示 | 反映できなかったとき・公開に失敗したときは赤で表示し、「サイトは前の状態のまま」と明記 |
| 記録 | すべての更新はGitHubのコミットとして残る（誰が・いつ・何を） |

## 更新先を増やす

`src/targets.js` に追加する（RuruPopPad本体など）。対象リポジトリをGitHubトークンの対象にも追加する。

## 設定

- `wrangler.jsonc` の vars：`CF_ACCOUNT_ID`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`
- シークレット：`GITHUB_TOKEN`（対象リポジトリの Contents 読み書き）、`CF_API_TOKEN`（任意。Workers CI 読み取り＋Workers Scripts 読み取り）
- Workers Builds：ビルドコマンド `npm run build`、デプロイコマンド `npx wrangler deploy`

## 手元での確認

`.dev.vars`（本番には絶対に入れない）：

```
GITHUB_TOKEN=dummy
GITHUB_API=http://127.0.0.1:9900
CF_API=http://127.0.0.1:9900
CF_API_TOKEN=dummy
DEV_SKIP_ACCESS=true
```

ネロは模擬のGitHub/Cloudflareサーバーで、反映・公開状況の表示・取り違え・範囲外ファイル・台本エラー・変更なし・削除・確認と実行のZIP不一致を確認済み（2026-11-25）。

## エンジンについて

`src/engine.cjs` は fates-beta の `src/engine.cjs` と同じもの（台本の検証に使う）。エンジンを直したら両方を更新する。
