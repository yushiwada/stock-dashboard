// 毎朝の「展望と考察」自動更新スクリプト（GitHub Actionsで実行）
// 1) Claude API（Haiku・ウェブ検索付き）で最新情報を調べ、index.html の ANALYSIS ブロックを書き換える
//    ※銘柄選定はLLMを使わず数値ベース（毎日Haikuの解説文コストのみで運用できる設計）
// 2) 複合スコア上位4銘柄を毎日1000円ずつ仮想購入（セクター上限2・決算±3日回避・保有中も買い増しあり）、
//    売却はATR連動トレーリングストップ（ATR14×3、8〜25%）と50日線割れのみ（保有期限なし）
// 3) 対照実験: オルカン（eMAXIS Slim 全世界株式・投信協会CSVの基準価額）を毎日4000円仮想積立して比較
// 4) ユニバースは日米の株式（時価総額上位）＋ETF（出来高上位）＋主要投資信託
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
- 絵文字・顔文字・装飾記号は一切使わない。淡々とした報告調の文体で書く
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
  // ウェブ検索が一時的に使えずJSONが出せなかった場合は少し待って再試行（一過性障害対策）
  const txt = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  if (!/\{[\s\S]*\}/.test(txt) && turn < 7) {
    console.log("JSONなし（検索障害の可能性）→ 60秒待って再試行");
    await new Promise(r => setTimeout(r, 60000));
    messages.length = 0;
    messages.push({ role: "user", content: prompt });
    continue;
  }
  break;
}
// Haiku 4.5: 入力$1/M・出力$5/M、ウェブ検索$10/1000回
const estCost = usage.in / 1e6 * 1 + usage.out / 1e6 * 5 + usage.searches * 0.01;
console.log(`推定コスト: $${estCost.toFixed(4)} (入力${usage.in}tok / 出力${usage.out}tok / 検索${usage.searches}回)`);

const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
// 波括弧の対応を数えてJSONを正確に切り出す（前後に余計なテキストや波括弧があっても壊れない）。
// 文字列内の生の改行・タブ等の制御文字はスペースに置換してからパース。
function extractJSON(t) {
  for (let i = t.indexOf("{"); i !== -1; i = t.indexOf("{", i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < t.length; j++) {
      const ch = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(t.slice(i, j + 1).replace(/[\u0000-\u001F]+/g, " ")); } catch (e) { break; }
        }
      }
    }
  }
  return null;
}
const out = extractJSON(text);
if (!out) throw new Error("JSONが見つかりません (stop_reason=" + data.stop_reason +
  ", blocks=" + (data.content || []).map(b => b.type).join(",") + "): " + text.slice(0, 300));
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
// 2000銘柄超のユニバースから複合スコア上位を選び、
// ①決算発表±3日以内は回避 ②同一セクター最大2銘柄 の制約で4銘柄採用。
const UA = "Mozilla/5.0";
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
// ===== 投資信託: 投信協会の公式CSV（日次基準価額・全履歴）から取得 =====
const FUNDS = [
  { symbol: "FUND:0331418A", name: "オルカン（eMAXIS Slim 全世界株式）", isin: "JP90C000H1T1", assoc: "0331418A", sector: "投信" },
  { symbol: "FUND:03311187", name: "eMAXIS Slim 米国株式（S&P500）", isin: "JP90C000GKC6", assoc: "03311187", sector: "投信" }
];
const _fundHist = {};
async function fundHistory(sym) {
  if (_fundHist[sym]) return _fundHist[sym];
  const f = FUNDS.find(x => x.symbol === sym);
  if (!f) return null;
  try {
    const url = `https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000/csv-file-download?isinCd=${f.isin}&associFundCd=${f.assoc}`;
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    let text;
    try { text = new TextDecoder("shift_jis").decode(buf); } catch (e) { text = new TextDecoder().decode(buf); }
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^(\d{4})年(\d{2})月(\d{2})日,(\d+)/);
      if (m) rows.push({ date: `${m[1]}-${m[2]}-${m[3]}`, nav: Number(m[4]) });
    }
    if (rows.length < 60) return null;
    _fundHist[sym] = rows;
    return rows;
  } catch (e) { return null; }
}
function fundMetrics(rows) {
  const closes = rows.map(r => r.nav);
  const price = closes[closes.length - 1];
  const at = n => closes[Math.max(0, closes.length - 1 - n)];
  const ret = n => { const p0 = at(n); return p0 ? price / p0 - 1 : null; };
  const sma = n => { const s = closes.slice(-n); return s.reduce((a, b) => a + b, 0) / s.length; };
  const win = closes.slice(-252);
  const hi = Math.max(...win), lo = Math.min(...win);
  const rec = closes.slice(-61);
  const rr = []; for (let i = 1; i < rec.length; i++) rr.push(rec[i] / rec[i - 1] - 1);
  const mu = rr.reduce((a, b) => a + b, 0) / (rr.length || 1);
  const vol = Math.sqrt(rr.reduce((a, b) => a + (b - mu) ** 2, 0) / (rr.length || 1));
  // 高値・安値データがないため、日次騰落率の平均絶対値をATR相当として使う
  const abs = rr.slice(-14).map(x => Math.abs(x));
  const atrRatio = abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : null;
  return { price, ret3m: ret(63), ret6m: ret(126), sma50: sma(50), sma200: sma(200),
    posInRange: hi > lo ? (price - lo) / (hi - lo) : 0.5, vol, atrRatio };
}
async function chartMetrics(sym) {
  if (sym.startsWith("FUND:")) {
    const rows = await fundHistory(sym);
    return rows ? fundMetrics(rows) : null;
  }
  try {
    const y = toYahoo(sym);
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${y}?range=1y&interval=1d`, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const res = ((await r.json()).chart || {}).result;
    const R = res && res[0];
    if (!R || !R.timestamp) return null;
    const qd = R.indicators.quote[0];
    const rows = R.timestamp.map((t, i) => ({ c: qd.close[i], h: qd.high && qd.high[i], l: qd.low && qd.low[i] }))
      .filter(x => x.c != null);
    const closes = rows.map(x => x.c);
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
    // ATR14（平均的な1日の値動き幅。ストップ幅の算出に使用）
    let atrRatio = null;
    const rws = rows.slice(-15);
    if (rws.length >= 8) {
      const trs = [];
      for (let i = 1; i < rws.length; i++) {
        const pc = rws[i - 1].c;
        const h = rws[i].h != null ? rws[i].h : rws[i].c;
        const l = rws[i].l != null ? rws[i].l : rws[i].c;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      }
      atrRatio = trs.reduce((a, b) => a + b, 0) / trs.length / price;
    }
    return { price, ret3m: ret(63), ret6m: ret(126), sma50: sma(50), sma200: sma(200), posInRange, vol, atrRatio };
  } catch (e) { return null; }
}
// Yahoo quoteSummary（cookie+crumb が必要）: セクター・決算日・アナリスト目標を取得
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
async function enrichExtra(sym) {
  if (sym.startsWith("FUND:")) return {}; // 投信はYahoo情報なし（セクターは「投信」固定）
  const crumb = await ensureCrumb();
  if (!crumb) return {};
  try {
    const y = toYahoo(sym);
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${y}?modules=financialData,calendarEvents,assetProfile&crumb=${encodeURIComponent(crumb)}`;
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
    const sectorName = (R.assetProfile && R.assetProfile.sector) || null;
    return { analystUp, recMean: recMean != null ? recMean : null, earningsInDays, sectorName };
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
  if (c.ret6m != null) b.push(`200日線比${pct(c.ret6m)}・50日線比${pct(c.ret3m)}の上昇基調`);
  if (c.price > c.sma50 && c.sma50 > c.sma200) b.push("50日・200日移動平均線がともに上向きの強いトレンド");
  else if (c.price > c.sma50) b.push("50日線を上回り短期堅調");
  if (c.analystUp != null) b.push(`アナリスト平均目標まで${pct(c.analystUp)}の余地`);
  if (c.posInRange != null) b.push(`52週レンジの${Math.round(c.posInRange * 100)}%の位置`);
  if (c.mcDisp) b.push(c.mcDisp);
  if (c.sectorName) b.push(`セクター: ${c.sectorName}`);
  return b.join("、") + "。（数値スコアで自動選定）";
}
function buildRisk(c) {
  const b = [];
  if (c.vol != null) b.push(`日次ボラティリティ${(c.vol * 100).toFixed(1)}%${c.vol > 0.03 ? "と高め" : ""}`);
  if (c.atrRatio != null) b.push(`平均的な1日の値動き幅${(c.atrRatio * 100).toFixed(1)}%`);
  if (c.posInRange != null && c.posInRange > 0.9) b.push("52週高値圏で過熱感に注意");
  const secText = c.sectorName || c.sector || "";
  if (/半導体|Technology|Semiconductor/i.test(secText)) b.push("半導体・テック市況の反落リスク");
  else if (/金融|Financial/i.test(secText)) b.push("金利動向の影響");
  else if (/エネルギー|Energy/i.test(secText)) b.push("原油価格の変動");
  b.push("モメンタム失速時の反落");
  return b.join("、") + "。";
}
// ===== 2000銘柄ユニバース: Yahooスクリーナーで時価総額順に取得（失敗時は固定リストにフォールバック）=====
async function screenerPage(region, offset, quoteType = "EQUITY") {
  const crumb = await ensureCrumb();
  if (!crumb) return [];
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/screener?crumb=${encodeURIComponent(crumb)}&lang=en-US&region=US`, {
      method: "POST",
      headers: { "User-Agent": UA, "Cookie": _cookie, "content-type": "application/json" },
      body: JSON.stringify({
        size: 250, offset, sortField: quoteType === "ETF" ? "dayvolume" : "intradaymarketcap", sortType: "DESC", quoteType, topOperator: "AND",
        query: { operator: "AND", operands: [{ operator: "EQ", operands: ["region", region] }] },
        userId: "", userIdType: "guid"
      })
    });
    if (!r.ok) return [];
    const res = ((await r.json()).finance || {}).result;
    return (res && res[0] && res[0].quotes) || [];
  } catch (e) { return []; }
}
function toAppSym(q) {
  const s = q.symbol || "";
  if (/\.T$/.test(s)) { const c = s.replace(/\.T$/, ""); return /^[0-9A-Z]{4,5}$/.test(c) ? "TSE:" + c : null; }
  const ex = (q.exchange || "").toUpperCase();
  if (["NMS", "NGM", "NCM"].includes(ex)) return "NASDAQ:" + s;
  if (ex === "NYQ") return "NYSE:" + s;
  if (["PCX", "ASE"].includes(ex)) return "AMEX:" + s;
  return null;
}
async function ensureUniverse() {
  try {
    const u = JSON.parse(fs.readFileSync("universe.json", "utf8"));
    if (u && u.v === 2 && Array.isArray(u.list) && u.list.length > 500 && u.fetched && (Date.now() - new Date(u.fetched)) < 7 * 864e5) {
      console.log("universe: キャッシュ利用", u.list.length); return u.list;
    }
  } catch (e) {}
  const seen = new Set(), list = [];
  for (const qt of ["EQUITY", "ETF"]) {
    const maxOff = qt === "ETF" ? 500 : 1500; // ETFは出来高上位500×2市場
    for (const region of ["us", "jp"]) {
      for (let off = 0; off < maxOff; off += 250) {
        const quotes = await screenerPage(region, off, qt);
        if (!quotes.length) break;
        for (const q of quotes) {
          const sym = toAppSym(q);
          if (!sym || seen.has(sym)) continue;
          seen.add(sym);
          list.push({ name: q.shortName || q.longName || sym.split(":")[1], symbol: sym, ysym: q.symbol, etf: qt === "ETF" || undefined });
        }
        await sleep(200);
        if (quotes.length < 250) break;
      }
    }
  }
  if (list.length < 500) {
    console.log("universe: スクリーナー不足→固定リストにフォールバック", list.length);
    return UNIVERSE.map(u => ({ name: u.name, symbol: u.symbol, ysym: toYahoo(u.symbol) }));
  }
  try { fs.writeFileSync("universe.json", JSON.stringify({ fetched: new Date().toISOString(), v: 2, list })); } catch (e) {}
  console.log("universe: スクリーナー取得", list.length, `(ETF ${list.filter(x => x.etf).length}件を含む)`);
  return list;
}
// ===== バッチで価格・50/200日線・52週高安・時価総額・出来高を一括取得（1回200銘柄）=====
async function batchQuotes(entries) {
  const crumb = await ensureCrumb();
  const out = {};
  for (let i = 0; i < entries.length; i += 200) {
    const syms = entries.slice(i, i + 200).map(e => e.ysym).join(",");
    try {
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms)}${crumb ? "&crumb=" + encodeURIComponent(crumb) : ""}`;
      const r = await fetch(url, { headers: { "User-Agent": UA, "Cookie": _cookie || "" } });
      if (r.ok) { const res = ((await r.json()).quoteResponse || {}).result || []; for (const q of res) out[q.symbol] = q; }
    } catch (e) {}
    await sleep(200);
  }
  return out;
}
// ===== 制約付き採用: スコア順に ①決算±3日回避 ②同一セクター最大2 で4銘柄選ぶ =====
const MAX_PER_SECTOR = 2, TOP_N = 4, POOL_N = 16;
async function adoptWithConstraints(ranked) {
  const pool = ranked.slice(0, POOL_N);
  // 上位候補だけ追加情報（セクター・決算日・アナリスト目標）を取得
  for (const c of pool) {
    const ex = await enrichExtra(c.symbol);
    Object.assign(c, ex);
    await sleep(150);
  }
  const picks = [], secCount = {};
  for (const c of pool) {
    if (c.earningsInDays != null && c.earningsInDays >= -1 && c.earningsInDays <= 3) {
      console.log("決算近接でスキップ:", c.name, `(${c.earningsInDays}日後)`); continue;
    }
    const sec = c.sectorName || c.sector || null;
    if (sec) {
      const n = secCount[sec] || 0;
      if (n >= MAX_PER_SECTOR) { console.log("セクター上限でスキップ:", c.name, `(${sec})`); continue; }
      secCount[sec] = n + 1;
    }
    picks.push(c);
    if (picks.length >= TOP_N) break;
  }
  return picks;
}
// バッチ経路が使えない場合の保険: 実績あるチャート取得で固定リストから選ぶ
async function selectPicksFallback() {
  const cands = [];
  for (const u of UNIVERSE.concat(FUNDS)) { const m = await chartMetrics(u.symbol); if (m) cands.push(Object.assign({}, u, m)); await sleep(120); }
  if (cands.length < 1) return [];
  // 保有中の銘柄も除外しない（スコア上位なら買い増しする）
  const ranked = scoreAndSelect(cands, { maxPerSector: 9999, topN: cands.length });
  const picks = await adoptWithConstraints(ranked);
  if (!picks.length) return [];
  console.log("採用(フォールバック):", picks.map(p => p.name).join(", "));
  return picks.map(t => ({ name: t.name, symbol: t.symbol, sector: t.sectorName || t.sector || null, reason: buildReason(t), risk: buildRisk(t) }));
}
async function selectPicks() {
  const universe = await ensureUniverse();
  const q = await batchQuotes(universe);
  console.log("picks: バッチ取得", Object.keys(q).length, "/", universe.length);
  const cands = [];
  for (const u of universe) {
    const d = q[u.ysym];
    if (!d) continue;
    const price = d.regularMarketPrice, ma50 = d.fiftyDayAverage, ma200 = d.twoHundredDayAverage;
    const hi = d.fiftyTwoWeekHigh, lo = d.fiftyTwoWeekLow;
    if (!price || !ma50 || !ma200 || !hi || !lo || hi <= lo) continue;
    const mc = d.marketCap || (u.etf ? (d.netAssets || 0) : 0), vol = d.averageDailyVolume3Month || d.regularMarketVolume || 0;
    const jpy = d.currency === "JPY";
    if (!u.etf && mc < (jpy ? 2e11 : 2e9)) continue; // 株式: 時価総額 約2000億円 / 20億ドル 以上
    if (price * vol < (jpy ? 1e9 : 1e7)) continue;   // 1日売買代金 約10億円 / 1000万ドル 以上
    cands.push({
      name: u.name, symbol: u.symbol, sector: u.etf ? "ETF" : null, price, sma50: ma50, sma200: ma200,
      posInRange: (price - lo) / (hi - lo), ret3m: price / ma50 - 1, ret6m: price / ma200 - 1, vol: null,
      mcDisp: u.etf ? "ETF" : (jpy ? `時価総額${Math.round(mc / 1e8)}億円` : `時価総額${(mc / 1e9).toFixed(0)}十億ドル`)
    });
  }
  // 投資信託を候補に追加（基準価額の履歴から同じ指標を計算）
  for (const f of FUNDS) {
    const rows = await fundHistory(f.symbol);
    if (!rows) continue;
    cands.push({ name: f.name, symbol: f.symbol, sector: f.sector, ...fundMetrics(rows), vol: null, mcDisp: "投資信託" });
  }
  console.log("picks: フィルタ後候補", cands.length, `(投信${cands.filter(c => c.sector === "投信").length}件を含む)`);
  if (cands.length < 5) { console.log("バッチ選定が不十分→チャート経路にフォールバック"); return await selectPicksFallback(); }
  // 保有中の銘柄も除外しない（スコア上位なら買い増しする）
  const ranked = scoreAndSelect(cands, { maxPerSector: 9999, topN: cands.length });
  const picks = await adoptWithConstraints(ranked);
  if (!picks.length) { console.log("採用なし"); return []; }
  for (const t of picks) console.log("採用:", t.name, t.symbol, "score=" + t.score.toFixed(3), "sector=" + (t.sectorName || "不明"));
  console.log("候補", cands.length, "銘柄から", picks.length, "銘柄採用（セクター上限2・決算±3日回避）");
  return picks.map(t => ({ name: t.name, symbol: t.symbol, sector: t.sectorName || null, reason: buildReason(t), risk: buildRisk(t) }));
}
try { out.picks = await selectPicks(); }
catch (e) { console.log("picks選定に失敗:", e.message); out.picks = []; }
if (!Array.isArray(out.picks)) out.picks = [];

// ===== 株価取得（Actionsのサーバー環境からはYahooに直接アクセス可能） =====
async function yQuote(symbol) {
  if (symbol.startsWith("FUND:")) {
    const rows = await fundHistory(symbol);
    if (!rows) throw new Error("fund nav " + symbol);
    return { price: rows[rows.length - 1].nav, currency: "JPY" };
  }
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

  // 保有銘柄の売却判定用データ（50日線・ATR）を取得
  const met = {};
  for (const pos of pf.open) {
    try { const m = await chartMetrics(pos.symbol); if (m) met[pos.symbol] = m; await sleep(120); } catch (e) {}
  }

  // ===== 動的売却判定(保有期限なし・毎日の株価で判断)=====
  // ①ボラ連動トレーリングストップ: ピーク比 -(ATR14×3)。8〜25%にクランプ。ATR不明時は-12%
  // ②50日線割れ（トレンド転換）
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const still = [];
  for (const pos of pf.open) {
    const pj = priceJPY[pos.symbol];
    if (pj == null) { still.push(pos); continue; } // 価格が取れない日は保有継続
    pos.peakJPY = Math.max(pos.peakJPY || pos.buyPriceJPY, pj);
    const m = met[pos.symbol];
    const trailPct = (m && m.atrRatio) ? clamp(3 * m.atrRatio, 0.08, 0.25) : 0.12;
    pos.trailPct = Math.round(trailPct * 1000) / 10; // 表示用(%)
    const trailingHit = pj <= pos.peakJPY * (1 - trailPct);
    const trendBreak = m ? m.price < m.sma50 : false;
    if (trailingHit || trendBreak) {
      const v = pos.units * pj;
      pf.realizedJPY += v;
      const why = trailingHit ? `トレーリングストップ(ピーク比-${pos.trailPct}%)` : "50日線割れ";
      pf.closed.push({ ...pos, sellDate: todayISO, sellValueJPY: Math.round(v * 10) / 10, sellReason: why });
      console.log("売却:", pos.name, why, pos.costJPY + "円 →", v.toFixed(1) + "円");
    } else {
      still.push(pos);
    }
  }
  pf.open = still;

  // ===== 当日の仮想購入(4銘柄・各1000円・1日1回のみ)=====
  if (pf.lastBuyDate !== todayISO) {
    for (const p of out.picks) {
      const pj = priceJPY[p.symbol];
      if (pj == null) continue;
      pf.open.push({
        symbol: p.symbol, name: p.name, sector: p.sector || null, buyDate: todayISO,
        units: 1000 / pj, buyPriceJPY: Math.round(pj * 100) / 100, peakJPY: pj, costJPY: 1000
      });
      pf.investedJPY += 1000;
    }
    pf.lastBuyDate = todayISO;
  }

  // ===== 対照実験: オルカン(eMAXIS Slim 全世界株式・基準価額)を毎日4000円仮想積立 =====
  const BENCH = FUNDS[0]; // eMAXIS Slim 全世界株式（オール・カントリー）
  if (!pf.benchmark) {
    pf.benchmark = { symbol: BENCH.symbol, name: BENCH.name,
      investedJPY: 0, units: 0, lastBuyDate: null, startDate: todayISO };
  }
  try {
    const rows = await fundHistory(BENCH.symbol);
    const bp = rows ? rows[rows.length - 1].nav : null; // 基準価額（1万口あたり円）
    if (bp) {
      // 旧ベンチマーク(2559 ETF代理)からの移行: 評価額を引き継いで口数換算
      if (pf.benchmark.symbol === "TSE:2559") {
        const carry = pf.benchmark.valuationJPY || pf.benchmark.investedJPY || 0;
        console.log(`ベンチマーク移行: 2559 → eMAXIS Slim（評価額${carry}円を引き継ぎ）`);
        pf.benchmark = { symbol: BENCH.symbol, name: BENCH.name, investedJPY: pf.benchmark.investedJPY,
          units: carry / bp, lastBuyDate: pf.benchmark.lastBuyDate, startDate: pf.benchmark.startDate };
      }
      if (pf.benchmark.lastBuyDate !== todayISO) {
        pf.benchmark.units += 4000 / bp;
        pf.benchmark.investedJPY += 4000;
        pf.benchmark.lastBuyDate = todayISO;
      }
      pf.benchmark.lastPriceJPY = bp;
      pf.benchmark.navDate = rows[rows.length - 1].date;
      pf.benchmark.valuationJPY = Math.round(pf.benchmark.units * bp * 10) / 10;
      console.log(`ベンチマーク更新: オルカン積立 投資${pf.benchmark.investedJPY}円 / 評価${pf.benchmark.valuationJPY}円 (基準価額${bp}円 ${pf.benchmark.navDate})`);
    } else {
      console.log("ベンチマーク: 基準価額が取得できず本日はスキップ");
    }
  } catch (e) { console.log("ベンチマーク更新失敗:", e.message); }

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

  // 日次履歴（戦略とベンチマークの推移。あとでグラフ化できるように保存）
  if (!Array.isArray(pf.history)) pf.history = [];
  const hEntry = {
    date: todayISO, inv: pf.investedJPY, val: pf.valuationJPY,
    bInv: pf.benchmark.investedJPY || 0, bVal: pf.benchmark.valuationJPY || 0
  };
  if (pf.history.length && pf.history[pf.history.length - 1].date === todayISO) {
    pf.history[pf.history.length - 1] = hEntry;
  } else {
    pf.history.push(hEntry);
  }

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
