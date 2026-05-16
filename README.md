# robotics-stocks

ロボティクス入門用の電子工作パーツ在庫＆買い物TODOダッシュボード。

公開: https://isseim0312.github.io/robotics-stocks/

## 構成

- 静的サイト（HTML / CSS / Vanilla JS）
- データは `data/inventory.json` と `data/shopping.json`
- 調達比較データは `data/procurement.json`
- TODO のチェック状態は `localStorage` に保存（端末ごと）
- レスポンシブ対応（モバイル優先）
- ダーク/ライト自動切替（OS設定に追従）

## ファイル

```
index.html         # ダッシュボード本体
styles.css         # スタイル
app.js             # 描画・タブ切替・検索・TODO 永続化
data/
  inventory.json   # 在庫マスタ
  shopping.json    # 買い物リスト（プロジェクト別）
  procurement.json # 秋葉原 vs 通販の調達比較データ
.nojekyll          # GitHub Pages の Jekyll 処理を無効化
```

## ローカルで開く

`file://` だと `fetch` が動かないため、簡易サーバーを使う。

```bash
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

## データの更新

- 在庫を変えたら `data/inventory.json` を編集
- 買い物リストを変えたら `data/shopping.json` を編集
- マスタは別リポジトリ `robotics/inventory/current_stock.yml` 側にあり、変更があったらこちらにも反映する

## デプロイ

`main` ブランチの root から GitHub Pages で配信。

1. GitHub の `Settings → Pages → Source = main / (root)` を有効化
2. push すると数十秒で公開される

## ステータスとカテゴリ

ステータス:

- `unopened` 未開封
- `unopened_or_partially_opened` 未/一部開封
- `opened` 開封済
- `in_use` 使用中
- `consumed` 消費済

確認度（confidence）:

- `high` 確認済
- `medium` 推定
- `low` 要確認
