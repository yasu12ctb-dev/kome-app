# Kome-app アイコン候補（実物調査後の再生成）

作成: 2026-10-01 [codex]。初稿は一般的な布製の巾着を描いており、日本で玄米30kgに使われる紙製米袋と違ったため不採用。実物調査後に OpenAI の組み込み ImageGen で全面再生成した。

## 実物調査で固定した形

- 30kg用の代表的な規格は、幅490×高さ800×マチ100mm、クラフト紙3層、ひも付き。縦長の矩形で浅いマチがある（[日栄産業](https://www.nichiei-sangyou.com/komebukuro/)）
- 30kg用には幅490×マチ100×高さ800mmの未晒クラフト2層・舟底・紙バンド付きもある（[山元紙包装社](https://www.yamagen-net.com/cement/)）
- クラフト重袋の口はクレープ紙を添えてミシン縫いし、開封用のカットテープを付ける方式が使われる（[山口包装工業](https://yamaguchi-kf-pack.com/%E7%B4%99%E8%A2%8B/%E3%82%AF%E3%83%A9%E3%83%95%E3%83%88%E9%87%8D%E8%A2%8B%E3%81%AE%E5%B0%81%E3%81%8B%E3%82%93%E3%81%AB%E4%BD%BF%E3%82%8F%E3%82%8C%E3%82%8B%E8%A2%8B%E5%8F%A3%E7%B8%AB%E3%83%9F%E3%82%B7%E3%83%B3/)）
- したがって、共通形状を「縦長または横倒しのクラフト紙袋／浅いマチ／角のある底／平らな折返し・紙バンド・縫い線」とした。布袋、巾着、絞った首、蝶結び、ロープ、荷札は全案で禁止した

共通条件: 非透過1024×1024 PNG、墨 `#1C1A17`・生成り `#F3EEE2`・稲穂 `#E9B632`・朱 `#C8402A`、外周の角丸なし、主要形状を中央80%のセーフ領域に収める。

## A — 正面の30kgクラフト米袋

立てた実物形状をそのまま記号化した案。平らな縫い口、マチ、角底を見せ、稲穂印刷と朱の検査印だけを加えた。

生成プロンプト要点:

> A real Japanese 30 kg multiwall kraft-paper brown-rice bag, approximately 490 mm wide × 800 mm tall × 100 mm gusset, upright front view. Tall rectangular paper sack, shallow side gussets, subtly bulging filled body, flat folded top with horizontal crepe-paper band and machine stitching, squared bottom. Rice-stalk print and small vermilion inspection seal. Never a cloth sack or drawstring pouch; no gathered neck, bow, rope, tag, or burlap.

## B — 斜めから見た30kgクラフト米袋

マチと紙の厚みが分かる三角視点。米粒の大印と小さな朱印で、ホーム画面上の判別を優先した。

生成プロンプト要点:

> A real filled 3-layer Japanese kraft-paper rice bag, about 490 × 800 × 100 mm, in three-quarter view. Elongated rectangular paper package with visible side gusset, flat machine-sewn short edge covered by a horizontal paper band, squared sealed bottom, large rice-grain print and small vermilion seal. Never a cloth sack or drawstring pouch; no gathered neck, bow, rope, tag, or burlap.

## C — 横積みした30kgクラフト米袋

2袋を横積みにして、受取記録の積み重なりを表した案。短辺の紙バンドと縫い線を見せて箱との差を出した。

生成プロンプト要点:

> Two real Japanese 30 kg multiwall kraft-paper rice bags stacked horizontally. Each is an elongated 490 × 800 × 100 mm filled-paper package with shallow gussets, softly bulging faces, squared ends, and a machine-stitched closure under a paper band along one short edge. Rice-stalk print and small vermilion seal. Never boxes or cloth sacks; no gathered neck, bow, rope, tag, or burlap.
