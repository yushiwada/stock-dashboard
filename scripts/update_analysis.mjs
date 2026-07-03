// 毎朝の「展望と考察」自動更新スクリプト（GitHub Actionsで実行）
// 1) Claude API（ウェブ検索付き）で最新情報を調べ、index.html の ANALYSIS ブロックを書き換える
// 2) 選定銘柄を毎日100円ずつ仮想購入し、期限日に売却する積立シミュレーション（portfolio.json）を更新する
import fs from "node:fs";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) throw new Error("ANTHROPIC_API_KEY がありません（リポジトリのSecretsに登録してください）");
const FILE = "index.html";
const PF_FILE = "portfolio.json";

const html = fs.readFileSync(FILE, "utf8");
const blockRe = /\/\* ===== ANALYSIS_START =====[\s\S]*?\/\* ===== ANALYSIS_END ===== \*\//;
const cur = html.match(blockRe);
if (!cur) throw new Error("ANALYSIS ブロックが見つかりません");

const today = new Date().toLocaleDateString("ja-JP", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric"
});
const todayISO = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }); // YYYY-MM-DD

const prompt = `あなたは個人用株価ダッシュボードの「展望と考察」欄を毎朝更新する編集者です。ウェブ検索で最新情報を調べ、最後に指定のJSONだけを出力してください。

今日の日付: ${today}（ISO表記: ${todayISO}）

参考（現在の内容・情報が古い）:
${cur[0].slice(0, 3500)}

調べること:
- 米国株（S&P500・NASDAQ100）の直近の動きと見通し、FRB・金利動向
- 日経平均の直近の動きと見通し
- 任天堂（東証7974）の直近の株価材料
- SpaceX（NASDAQ:SPCX、2026/6/12上場）の直近の株価材料
- 全世界株（MSCI ACWI／オルカン）に関わる大きな材料
- アナリスト評価が高い・材料が出た注目銘柄（picks用）
- 前日に±2%超の値動きがあった銘柄はその理由を詳しく

品質基準（必ず守る）:
- 各 outlook / note は2〜4文。株価水準・変化率・日付・目標値など具体的な数値を最低1つ含める
- 検索で確認した事実のみ。あいまいな一般論だけの文章は不可
- 数値は対象を取り違えない（S&P500とNASDAQ100の水準・目標値を混同しない等、桁が合っているか確認する）
- 引用タグ（<cite>など）や出典マークは本文に入れない。使えるタグは<b>と<br>のみ
- summary には「今日の注目イベント」と「前日の主な値動きと理由」を必ず入れる

出力形式: 次のキーを持つJSONのみを出力（コードブロック記法は使わない。文字列内の改行は\\nでエスケープ）:
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
 "picks": [ちょうど4銘柄の配列。{"name":"銘柄名","symbol":"チャート用シンボル（米国株=NASDAQ:xxx/NYSE:xxx/AMEX:xxx、東証=TSE:4桁コード。この形式以外は不可）","reason":"注目根拠（アナリスト評価や決算などの事実。数値を含める）","risk":"主なリスク","deadline":"YYYY-MM-DD形式。上昇根拠が実現すると見込む期限。今日から2〜8週間先で、根拠に応じて銘柄ごとに設定（例: 決算が根拠なら決算日直後）"}],
 "summary": "スマホ通知用の朝サマリー。プレーンテキスト3〜5行。今日の注目点・大きな値動きとその理由・今日の主要イベント"
}

制約: 投資助言はしない（事実とアナリスト見通しの紹介に留める。picksも「注目銘柄の紹介」であり推奨ではない）。各テキストは日本語。`;

// ===== Claude API 呼び出し（pause_turn 継続ループ + 使用量ログ） =====
const messages = [{ role: "user", content: prompt }];
let data;
const usage = { in: 0, out: 0, searches: 0 };
for (let turn = 0; turn < 8; turn++) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001", // コスト削減のためHaiku（Sonnetの約1/5）
      max_tokens: 8000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages
    })
  });
  if (!res.ok) throw new Error("Claude API エラー " + res.status + ": " + (await res.text()).slice(0, 500));
  data = await res.json();
  if (data.usage) {
    usage.in += data.usage.input_tokens || 0;
    usage.out += data.usage.output_tokens || 0;
    usage.searches += (data.usage.server_tool_use && data.usage.server_tool_use.web_search_requests) || 0;
  }
  console.log("turn", turn, "stop_reason:", data.stop_reason, "usage:", JSON.stringify(data.usage));
  if (data.stop_reason === "pause_turn" || data.stop_reason === "max_tokens") {
    messages.push({ role: "assistant", content: data.content });
    if (data.stop_reason === "max_tokens") {
      messages.push({ role: "user", content: "続けて、指定のJSONのみを出力してください。" });
    }
    continue;
  }
  break;
}
// Haiku 4.5: 入力$1/M・出力$5/M、ウェブ検索$10/1000回
const estCost = usage.in / 1e6 * 1 + usage.out / 1e6 * 5 + usage.searches * 0.01;
console.log(`推定コスト: $${estCost.toFixed(4)} (入力${usage.in}tok / 出力${usage.out}tok / 検索${usage.searches}回)`);

const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
const jm = text.match(/\{[\s\S]*\}/);
if (!jm) throw new Error("JSONが見つかりません (stop_reason=" + data.stop_reason +
  ", blocks=" + (data.content || []).map(b => b.type).join(",") + "): " + text.slice(0, 300));
// 文字列内に生の改行・タブ等の制御文字が混ざると不正なJSONになるため、スペースに置換してからパース。
const out = JSON.parse(jm[0].replace(/[\u0000-\u001F]+/g, " "));
for (const k of ["asof", "market", "items", "summary"]) {
  if (!(k in out)) throw new Error("キー不足: " + k);
}
// 引用タグ等の混入を除去（<b> <br> <a>以外のタグを削除）
const cleanStr = v => typeof v === "string"
  ? v.replace(/<(?!\/?(b|br|a)\b)[^>]*>/gi, "").replace(/\s{2,}/g, " ").trim()
  : v;
const deepClean = o => {
  if (typeof o === "string") return cleanStr(o);
  if (Array.isArray(o)) return o.map(deepClean);
  if (o && typeof o === "object") { for (const k in o) o[k] = deepClean(o[k]); }
  return o;
};
deepClean(out);
if (!Array.isArray(out.picks)) out.picks = [];
out.picks = out.picks.filter(p => p && p.name && /^[A-Z_]+:[A-Z0-9.]+$/.test(p.symbol || "")).slice(0, 4);
// deadline の補正（不正・近すぎ・遠すぎは28日後に）
const plus = d => { const t = new Date(todayISO); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); };
for (const p of out.picks) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.deadline || "") || p.deadline <= todayISO || p.deadline > plus(70)) {
    p.deadline = plus(28);
  }
}

// ===== 株価取得（Actionsのサーバー環境からはYahooに直接アクセス可能） =====
async function yQuote(symbol) {
  const code = symbol.startsWith("TSE:") ? symbol.slice(4) + ".T" : symbol.split(":")[1];
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}?range=5d&interval=1d`,
    { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("quote " + symbol + " " + r.status);
  const meta = (await r.json()).chart.result[0].meta;
  return { price: meta.regularMarketPrice, currency: meta.currency || "USD" };
}
let usdjpy = null;
async function toJPY(q) {
  if (q.currency === "JPY") return q.price;
  if (!usdjpy) {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/JPY=X?range=5d&interval=1d",
      { headers: { "User-Agent": "Mozilla/5.0" } });
    usdjpy = (await r.json()).chart.result[0].meta.regularMarketPrice;
  }
  return q.price * usdjpy;
}

// ===== 積立シミュレーション更新 =====
try {
  let pf = { investedJPY: 0, realizedJPY: 0, open: [], closed: [], lastBuyDate: null };
  try { pf = JSON.parse(fs.readFileSync(PF_FILE, "utf8")); } catch (e) {}

  const symbols = new Set([...pf.open.map(p => p.symbol), ...out.picks.map(p => p.symbol)]);
  const priceJPY = {};
  for (const s of symbols) {
    try { priceJPY[s] = await toJPY(await yQuote(s)); } catch (e) { console.log("価格取得失敗:", s, e.message); }
  }

  // 期限到来分を売却
  const still = [];
  for (const pos of pf.open) {
    if (pos.deadline <= todayISO && priceJPY[pos.symbol] != null) {
      const v = pos.units * priceJPY[pos.symbol];
      pf.realizedJPY += v;
      pf.closed.push({ ...pos, sellDate: todayISO, sellValueJPY: Math.round(v * 10) / 10 });
      console.log("売却:", pos.name, pos.costJPY + "円 →", v.toFixed(1) + "円");
    } else {
      still.push(pos);
    }
  }
  pf.open = still;

  // 当日の仮想購入（各100円・1日1回のみ）
  if (pf.lastBuyDate !== todayISO) {
    for (const p of out.picks) {
      const pj = priceJPY[p.symbol];
      if (pj == null) continue;
      pf.open.push({
        symbol: p.symbol, name: p.name, buyDate: todayISO, deadline: p.deadline,
        units: 100 / pj, buyPriceJPY: Math.round(pj * 100) / 100, costJPY: 100
      });
      pf.investedJPY += 100;
    }
    pf.lastBuyDate = todayISO;
  }

  // 評価額 = 実現分 + 保有分の現在価値
  let openValue = 0;
  for (const pos of pf.open) {
    const pj = priceJPY[pos.symbol];
    pos.curValueJPY = pj != null ? Math.round(pos.units * pj * 10) / 10 : pos.costJPY;
    openValue += pos.curValueJPY;
  }
  pf.valuationJPY = Math.round((pf.realizedJPY + openValue) * 10) / 10;
  pf.realizedJPY = Math.round(pf.realizedJPY * 10) / 10;
  pf.updated = todayISO;
  fs.writeFileSync(PF_FILE, JSON.stringify(pf, null, 2));
  console.log(`ポートフォリオ更新: 投資${pf.investedJPY}円 / 評価${pf.valuationJPY}円 / 保有${pf.open.length}件`);
} catch (e) {
  console.log("シミュレーション更新をスキップ:", e.message);
}

// ===== ANALYSIS ブロック書き換え =====
const { summary, ...analysis } = out;
const newBlock = `/* ===== ANALYSIS_START =====
   このブロックは毎朝の自動処理（GitHub Actions + Claude API）が書き換える。手動編集しない。 */
const ANALYSIS = ${JSON.stringify(analysis, null, 2)};
/* ===== ANALYSIS_END ===== */`;
const updated = html.replace(blockRe, () => newBlock);
new Function(newBlock.replace(/\/\*[\s\S]*?\*\//g, "") + "; return ANALYSIS;")();
fs.writeFileSync(FILE, updated);
fs.writeFileSync("summary.txt", summary);
console.log("更新完了:", out.asof, "picks:", out.picks.length);
console.log(summary);
