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
 "summary": "スマホ通知用の朝サマリー。プレーンテキスト3〜5行。今日の注目点・大きな値動きとその理由・今日の主要イベント"
}

制約: 投資助言はしない（事実とアナリスト見通しの紹介に留める）。各テキストは日本語。`;

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
// ===== 注目個別株の選定（数値ベースの複合スコア。Haikuの判断は使わない） =====
// 事前検証済みの固定ユニバースから、実データ（Yahoo）で計算した複合スコアで上位4件を選ぶ。
// 因子: モメンタム(3/6ヶ月)・トレンド(50/200日線)・割安(52週レンジ位置)・低ボラ、
//       取得できればアナリスト目標上昇余地・推奨度。セクター分散(最大2)。
const UA = "Mozilla/5.0";
const plus = d => { const t = new Date(todayISO); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UNIVERSE = [
  { name: "エヌビディア", symbol: "NASDAQ:NVDA", sector: "半導体" },
  { name: "ブロードコム", symbol: "NASDAQ:AVGO", sector: "半導体" },
  { name: "AMD", symbol: "NASDAQ:AMD", sector: "半導体" },
  { name: "マイクロン", symbol: "NASDAQ:MU", sector: "半導体" },
  { name: "クアルコム", symbol: "NASDAQ:QCOM", sector: "半導体" },
  { name: "東京エレクトロン", symbol: "TSE:8035", sector: "半導体" },
  { name: "アドバンテスト", symbol: "TSE:6857", sector: "半導体" },
  { name: "レーザーテック", symbol: "TSE:6920", sector: "半導体" },
  { name: "ディスコ", symbol: "TSE:6146", sector: "半導体" },
  { name: "キオクシア", symbol: "TSE:285A", sector: "半導体" },
  { name: "アップル", symbol: "NASDAQ:AAPL", sector: "テック" },
  { name: "マイクロソフト", symbol: "NASDAQ:MSFT", sector: "テック" },
  { name: "アルファベット", symbol: "NASDAQ:GOOGL", sector: "テック" },
  { name: "アマゾン", symbol: "NASDAQ:AMZN", sector: "テック" },
  { name: "メタ", symbol: "NASDAQ:META", sector: "テック" },
  { name: "ネットフリックス", symbol: "NASDAQ:NFLX", sector: "テック" },
  { name: "オラクル", symbol: "NYSE:ORCL", sector: "テック" },
  { name: "パランティア", symbol: "NASDAQ:PLTR", sector: "テック" },
  { name: "テスラ", symbol: "NASDAQ:TSLA", sector: "自動車" },
  { name: "トヨタ自動車", symbol: "TSE:7203", sector: "自動車" },
  { name: "JPモルガン", symbol: "NYSE:JPM", sector: "金融" },
  { name: "バンク・オブ・アメリカ", symbol: "NYSE:BAC", sector: "金融" },
  { name: "ビザ", symbol: "NYSE:V", sector: "金融" },
  { name: "三菱UFJ", symbol: "TSE:8306", sector: "金融" },
  { name: "三井住友FG", symbol: "TSE:8316", sector: "金融" },
  { name: "イーライリリー", symbol: "NYSE:LLY", sector: "ヘルスケア" },
  { name: "ユナイテッドヘルス", symbol: "NYSE:UNH", sector: "ヘルスケア" },
  { name: "第一三共", symbol: "TSE:4568", sector: "ヘルスケア" },
  { name: "ウォルマート", symbol: "NYSE:WMT", sector: "消費" },
  { name: "コストコ", symbol: "NASDAQ:COST", sector: "消費" },
  { name: "任天堂", symbol: "TSE:7974", sector: "消費" },
  { name: "ファーストリテイリング", symbol: "TSE:9983", sector: "消費" },
  { name: "エクソンモービル", symbol: "NYSE:XOM", sector: "エネルギー" },
  { name: "伊藤忠商事", symbol: "TSE:8001", sector: "商社" },
  { name: "三菱商事", symbol: "TSE:8058", sector: "商社" },
  { name: "半導体ETF(SMH)", symbol: "NASDAQ:SMH", sector: "ETF" }
];
const toYahoo = sym => sym.startsWith("TSE:") ? sym.slice(4) + ".T" : sym.split(":")[1];
async function chartMetrics(sym) {
  try {
    const y = toYahoo(sym);
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${y}?range=1y&interval=1d`, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const res = ((await r.json()).chart || {}).result;
    const R = res && res[0];
    if (!R || !R.timestamp) return null;
    const q = R.indicators.quote[0].close;
    const closes = R.timestamp.map((t, i) => q[i]).filter(x => x != null);
    if (closes.length < 60) return null;
    const price = closes[closes.length - 1];
    // 明らかな異常ティック（データ破損）を弾く: 直近値が1年の中央値の8倍超/1/8未満なら除外
    const med = [...closes].sort((a, b) => a - b)[Math.floor(closes.length / 2)];
    if (med && (price > med * 8 || price < med / 8)) return null;
    const at = n => closes[Math.max(0, closes.length - 1 - n)];
    const ret = n => { const p0 = at(n); return p0 ? price / p0 - 1 : null; };
    const sma = n => { const s = closes.slice(-n); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
    const win = closes.slice(-252);
    const hi = Math.max(...win), lo = Math.min(...win);
    const posInRange = hi > lo ? (price - lo) / (hi - lo) : 0.5;
    const rec = closes.slice(-61);
    const rr = []; for (let i = 1; i < rec.length; i++) rr.push(rec[i] / rec[i - 1] - 1);
    const mu = rr.reduce((a, b) => a + b, 0) / rr.length;
    const vol = Math.sqrt(rr.reduce((a, b) => a + (b - mu) ** 2, 0) / rr.length);
    return { price, ret3m: ret(63), ret6m: ret(126), sma50: sma(50), sma200: sma(200), posInRange, vol };
  } catch (e) { return null; }
}
// アナリスト系（任意・取得できなければ無視）。Yahoo quoteSummary は cookie+crumb が必要。
let _crumb = null, _cookie = null;
async function ensureCrumb() {
  if (_crumb !== null) return _crumb;
  try {
    const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA } });
    const sc = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get("set-cookie")].filter(Boolean);
    _cookie = sc.map(c => c.split(";")[0]).join("; ");
    const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, "Cookie": _cookie } });
    const t = (await r2.text()).trim();
    _crumb = (!t || t.length > 20 || /[<>]|error/i.test(t)) ? "" : t;
  } catch (e) { _crumb = ""; }
  return _crumb;
}
async function analystExtra(sym) {
  const crumb = await ensureCrumb();
  if (!crumb) return {};
  try {
    const y = toYahoo(sym);
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${y}?modules=financialData,calendarEvents&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetch(url, { headers: { "User-Agent": UA, "Cookie": _cookie } });
    if (!r.ok) return {};
    const res = ((await r.json()).quoteSummary || {}).result;
    const R = res && res[0];
    if (!R) return {};
    const fd = R.financialData || {};
    const price = fd.currentPrice && fd.currentPrice.raw, tgt = fd.targetMeanPrice && fd.targetMeanPrice.raw;
    const recMean = fd.recommendationMean && fd.recommendationMean.raw;
    const analystUp = (price && tgt) ? tgt / price - 1 : null;
    let earningsInDays = null;
    const ce = R.calendarEvents && R.calendarEvents.earnings && R.calendarEvents.earnings.earningsDate;
    if (ce && ce[0] && ce[0].raw) earningsInDays = Math.round((ce[0].raw * 1000 - Date.now()) / 86400000);
    return { analystUp, recMean: recMean != null ? recMean : null, earningsInDays };
  } catch (e) { return {}; }
}
function zscores(arr) {
  const v = arr.filter(x => x != null && isFinite(x));
  if (v.length < 2) return arr.map(() => 0);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
  return arr.map(x => (x != null && isFinite(x)) ? (x - m) / sd : null);
}
const WEIGHTS = { momentum: 0.30, trend: 0.20, analystUp: 0.18, rating: 0.10, value: 0.12, lowVol: 0.10 };
function scoreAndSelect(cands, opts) {
  const maxPerSector = (opts && opts.maxPerSector) || 2;
  const topN = (opts && opts.topN) || 4;
  const mom = cands.map(c => (c.ret3m != null && c.ret6m != null) ? 0.5 * c.ret3m + 0.5 * c.ret6m : null);
  const up = cands.map(c => c.analystUp != null ? c.analystUp : null);
  const val = cands.map(c => c.posInRange != null ? (1 - c.posInRange) : null);
  const vol = cands.map(c => c.vol != null ? c.vol : null);
  const rating = cands.map(c => c.recMean != null ? (3 - c.recMean) : null);
  const zMom = zscores(mom), zUp = zscores(up), zVal = zscores(val), zVol = zscores(vol), zRating = zscores(rating);
  const scored = cands.map((c, i) => {
    const trend = ((c.price > c.sma50 ? 0.5 : 0) + (c.sma50 > c.sma200 ? 0.5 : 0));
    const parts = [
      ["momentum", zMom[i]],
      ["trend", trend * 2 - 1],
      ["analystUp", zUp[i]],
      ["rating", zRating[i]],
      ["value", zVal[i]],
      ["lowVol", zVol[i] != null ? -zVol[i] : null]
    ];
    let wsum = 0, s = 0;
    for (const kv of parts) { if (kv[1] != null) { s += WEIGHTS[kv[0]] * kv[1]; wsum += WEIGHTS[kv[0]]; } }
    return Object.assign({}, c, { trend, score: wsum > 0 ? s / wsum : -Infinity });
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = [], sec = {};
  for (const c of scored) {
    const n = sec[c.sector] || 0;
    if (n >= maxPerSector) continue;
    picked.push(c); sec[c.sector] = n + 1;
    if (picked.length >= topN) break;
  }
  return picked;
}
const pct = x => (x >= 0 ? "+" : "") + (x * 100).toFixed(0) + "%";
function buildReason(c) {
  const b = [];
  if (c.ret3m != null && c.ret6m != null) b.push(`3ヶ月${pct(c.ret3m)}・6ヶ月${pct(c.ret6m)}のモメンタム`);
  if (c.price > c.sma50 && c.sma50 > c.sma200) b.push("50日・200日移動平均線の上で上昇トレンド");
  else if (c.price > c.sma50) b.push("50日線を上回り短期は堅調");
  if (c.analystUp != null) b.push(`アナリスト平均目標まで${pct(c.analystUp)}の余地`);
  if (c.posInRange != null) b.push(`52週レンジの${Math.round(c.posInRange * 100)}%の位置`);
  return b.join("、") + "。（数値スコアで自動選定）";
}
function buildRisk(c) {
  const b = [];
  if (c.vol != null) b.push(`日次ボラティリティ${(c.vol * 100).toFixed(1)}%${c.vol > 0.03 ? "と高め" : ""}`);
  if (c.posInRange != null && c.posInRange > 0.9) b.push("52週高値圏で過熱感に注意");
  if (c.sector === "半導体") b.push("半導体市況の反落リスク");
  else if (c.sector === "金融") b.push("金利動向の影響");
  else if (c.sector === "エネルギー") b.push("原油価格の変動");
  b.push("モメンタム失速時の反落");
  return b.join("、") + "。";
}
const deadlineFor = c => (c.earningsInDays != null && c.earningsInDays >= 5 && c.earningsInDays <= 45) ? plus(c.earningsInDays + 1) : plus(28);
async function selectPicks() {
  const cands = [];
  for (const u of UNIVERSE) {
    const m = await chartMetrics(u.symbol);
    if (m) cands.push(Object.assign({}, u, m));
    await sleep(120);
  }
  console.log("picks: チャート取得", cands.length, "/", UNIVERSE.length);
  if (cands.length < 4) return [];
  // Phase1: チャートのみで順位付け → 上位を絞る
  const prelim = scoreAndSelect(cands, { maxPerSector: 99, topN: cands.length });
  const shortlist = prelim.slice(0, Math.min(14, prelim.length));
  // Phase2: 上位のみアナリスト/決算を付与
  for (const c of shortlist) { Object.assign(c, await analystExtra(c.symbol)); await sleep(120); }
  // 保有中の銘柄は除外し、複合スコア最上位の1銘柄だけを選ぶ（1日1ピック）
  let held = new Set();
  try { const pf = JSON.parse(fs.readFileSync(PF_FILE, "utf8")); held = new Set((pf.open || []).map(p => p.symbol)); } catch (e) {}
  const ranked = scoreAndSelect(shortlist, { maxPerSector: 99, topN: shortlist.length });
  const top = ranked.find(c => !held.has(c.symbol));
  if (!top) { console.log("採用なし（候補が全て保有中）"); return []; }
  console.log("採用:", top.name, top.symbol, "score=" + top.score.toFixed(3));
  return [{ name: top.name, symbol: top.symbol, reason: buildReason(top), risk: buildRisk(top) }];
}
try { out.picks = await selectPicks(); }
catch (e) { console.log("picks選定に失敗:", e.message); out.picks = []; }
if (!Array.isArray(out.picks)) out.picks = [];

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

  // 保有銘柄のトレンド判定用に50日移動平均線割れをチェック（取得できた分だけ）
  const belowMA50 = {};
  for (const pos of pf.open) {
    try { const m = await chartMetrics(pos.symbol); if (m) belowMA50[pos.symbol] = m.price < m.sma50; await sleep(120); } catch (e) {}
  }

  // ===== 動的売却判定（固定期限なし・毎日の株価で判断）=====
  // ①ピーク比 -12% のトレーリングストップ ②50日線割れ（トレンド転換）③最長90日で利確
  const TRAIL = 0.12, MAX_HOLD = 90;
  const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const still = [];
  for (const pos of pf.open) {
    const pj = priceJPY[pos.symbol];
    if (pj == null) { still.push(pos); continue; } // 価格が取れない日は保有継続
    pos.peakJPY = Math.max(pos.peakJPY || pos.buyPriceJPY, pj);
    const heldDays = daysBetween(pos.buyDate, todayISO);
    const trailingHit = pj <= pos.peakJPY * (1 - TRAIL);
    const trendBreak = belowMA50[pos.symbol] === true;
    const maxHold = heldDays >= MAX_HOLD;
    if (trailingHit || trendBreak || maxHold) {
      const v = pos.units * pj;
      pf.realizedJPY += v;
      const why = trailingHit ? `トレーリングストップ(ピーク比-${Math.round(TRAIL * 100)}%)` : trendBreak ? "50日線割れ" : `最長保有${MAX_HOLD}日`;
      pf.closed.push({ ...pos, sellDate: todayISO, sellValueJPY: Math.round(v * 10) / 10, sellReason: why });
      console.log("売却:", pos.name, why, pos.costJPY + "円 →", v.toFixed(1) + "円");
    } else {
      still.push(pos);
    }
  }
  pf.open = still;

  // ===== 当日の仮想購入（1銘柄・100円・1日1回のみ）=====
  if (pf.lastBuyDate !== todayISO) {
    for (const p of out.picks) {
      const pj = priceJPY[p.symbol];
      if (pj == null) continue;
      pf.open.push({
        symbol: p.symbol, name: p.name, buyDate: todayISO,
        units: 100 / pj, buyPriceJPY: Math.round(pj * 100) / 100, peakJPY: pj, costJPY: 100
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
