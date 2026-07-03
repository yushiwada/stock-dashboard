// 毎朝の「展望と考察」自動更新スクリプト（GitHub Actionsで実行）
// Claude API（ウェブ検索付き）で最新情報を調べ、index.html の ANALYSIS ブロックを書き換える。
import fs from "node:fs";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) throw new Error("ANTHROPIC_API_KEY がありません（リポジトリのSecretsに登録してください）");
const FILE = "index.html";

const html = fs.readFileSync(FILE, "utf8");
const blockRe = /\/\* ===== ANALYSIS_START =====[\s\S]*?\/\* ===== ANALYSIS_END ===== \*\//;
const cur = html.match(blockRe);
if (!cur) throw new Error("ANALYSIS ブロックが見つかりません");

const today = new Date().toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric"
});

const prompt = `あなたは個人用株価ダッシュボードの「展望と考察」欄を毎朝更新する編集者です。ウェブ検索で最新情報を調べ、最後に指定のJSONだけを出力してください。

今日の日付: ${today}

参考（現在の内容・情報が古い）:
${cur[0].slice(0, 7000)}

調べること:
- 米国株（S&P500・NASDAQ100）の直近の動きと見通し、FRB・金利動向
- 日経平均の直近の動きと見通し
- 任天堂（東証7974）の直近の株価材料
- SpaceX（NASDAQ:SPCX、2026/6/12上場）の直近の株価材料
- 全世界株（MSCI ACWI／オルカン）に関わる大きな材料
- 前日に±2%超の値動きがあった銘柄はその理由を詳しく

出力形式: 次のキーを持つJSONのみを出力（コードブロック記法は使わない）:
{
 "asof": "YYYY/M/D（今日の日付）",
  "market": "マーケット全体の見通しHTML。<b>米国株:</b>…<br><b>日本株:</b>…<br><b>見方のコツ:</b>… の3段構成。使えるタグは<b>と<br>のみ",
   "items": {
      "TSE:2559": {"outlook": "今後の展望", "note": "直近の値動きの考察（大変動があれば理由）"},
         "FOREXCOM:SPXUSD": {"outlook": "...", "note": "..."},
            "FOREXCOM:NSXUSD": {"outlook": "...", "note": "..."},
               "FOREXCOM:JP225": {"outlook": "...", "note": "..."},
                  "TSE:7974": {"outlook": "...", "note": "..."},
                     "NASDAQ:SPCX": {"outlook": "...", "note": "..."}
                      },
                       "summary": "スマホ通知用の朝サマリー。プレーンテキスト3〜5行。今日の注目点・大きな値動きとその理由・今日の主要イベント"
                       }

                       制約: 事実は検索で確認できたもののみ書く。投資助言はしない（事実とアナリスト見通しの紹介に留める）。各テキストは日本語。`;

const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
    },
    body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 4096,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
          messages: [{ role: "user", content: prompt }]
    })
});
if (!res.ok) throw new Error("Claude API エラー " + res.status + ": " + (await res.text()).slice(0, 500));
const data = await res.json();
const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
const jm = text.match(/\{[\s\S]*\}/);
if (!jm) throw new Error("JSONが見つかりません: " + text.slice(0, 300));
const out = JSON.parse(jm[0]);
for (const k of ["asof", "market", "items", "summary"]) {
    if (!(k in out)) throw new Error("キー不足: " + k);
}

const { summary, ...analysis } = out;
const newBlock = `/* ===== ANALYSIS_START =====
   このブロックは毎朝の自動処理（GitHub Actions + Claude API）が書き換える。手動編集しない。 */
   const ANALYSIS = ${JSON.stringify(analysis, null, 2)};
   /* ===== ANALYSIS_END ===== */`;

// 置換文字列内の $ を特殊解釈させないため関数形式で置換
const updated = html.replace(blockRe, () => newBlock);

// 更新後のJSが壊れていないか簡易チェック（ANALYSISブロックだけ評価）
new Function(newBlock.replace(/\/\*[\s\S]*?\*\//g, "") + "; return ANALYSIS;")();

fs.writeFileSync(FILE, updated);
fs.writeFileSync("summary.txt", summary);
console.log("更新完了:", out.asof);
console.log(summary);
