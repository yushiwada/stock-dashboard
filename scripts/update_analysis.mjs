// 毎朝の「展望と考察」自動更新スクリプト（GitHub Actionsで実行）
// 1) LLM・有料APIは不使用（0円運用）。無料の株価データのみで毎日更新する
// 2) 積立4000円は毎日待機資金へ、購入は週1回まとめて複合スコア上位に配分（セクター評価額35%・単一銘柄15%以内・決算±3日回避・買い増しあり）、
//    売却は暴落ストップ（ピーク比-35%固定・毎日判定）と分散トリム（月1回）のみ（保有期限なし）
// 3) 対照実験: オルカン（eMAXIS Slim 全世界株式・投信協会CSVの基準価額）を毎日4000円仮想積立して比較
// 4) ユニバースは日米の株式（時価総額上位）＋ETF（出来高上位）＋主要投資信託
import fs from "node:fs";

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

// ===== 解説生成は廃止（0円運用） =====
// LLMは使わない。既存のANALYSISブロックの内容を引き継ぎ、picks（注目銘柄）だけを毎日更新する。
let out = null;
{
  const om = cur[0].match(/const ANALYSIS = ([\s\S]*?);\s*\n\/\* ===== ANALYSIS_END/);
  try { out = om ? JSON.parse(om[1]) : null; } catch (e) {}
  if (!out) out = { market: "", items: {} };
  out.asof = today;
  out.summary = today + " の注目銘柄と積立シミュレーションを更新しました。";
}
// ===== 注目個別株の選定（数値ベースの複合スコア） =====
// 2000銘柄超のユニバースから複合スコア上位を選び、
// ①決算発表±3日以内は回避 ②同一セクター最大2銘柄 の制約で4銘柄採用。
const UA = "Mozilla/5.0";
const sleep = ms => new Promise(r => setTimeout(r, ms));
// スクリーナー取得が失敗した時のフォールバック用ユニバース（約130銘柄・全セクター）。
const UNIVERSE = [
  // 半導体
  { name: "エヌビディア", symbol: "NASDAQ:NVDA", sector: "半導体" },
  { name: "ブロードコム", symbol: "NASDAQ:AVGO", sector: "半導体" },
  { name: "AMD", symbol: "NASDAQ:AMD", sector: "半導体" },
  { name: "マイクロン", symbol: "NASDAQ:MU", sector: "半導体" },
  { name: "クアルコム", symbol: "NASDAQ:QCOM", sector: "半導体" },
  { name: "テキサス・インスツルメンツ", symbol: "NASDAQ:TXN", sector: "半導体" },
  { name: "インテル", symbol: "NASDAQ:INTC", sector: "半導体" },
  { name: "ASML", symbol: "NASDAQ:ASML", sector: "半導体" },
  { name: "アプライドマテリアルズ", symbol: "NASDAQ:AMAT", sector: "半導体" },
  { name: "東京エレクトロン", symbol: "TSE:8035", sector: "半導体" },
  { name: "アドバンテスト", symbol: "TSE:6857", sector: "半導体" },
  { name: "レーザーテック", symbol: "TSE:6920", sector: "半導体" },
  { name: "ディスコ", symbol: "TSE:6146", sector: "半導体" },
  { name: "キオクシア", symbol: "TSE:285A", sector: "半導体" },
  { name: "ローム", symbol: "TSE:6963", sector: "半導体" },
  { name: "村田製作所", symbol: "TSE:6981", sector: "半導体" },
  // テック
  { name: "アップル", symbol: "NASDAQ:AAPL", sector: "テック" },
  { name: "マイクロソフト", symbol: "NASDAQ:MSFT", sector: "テック" },
  { name: "アルファベット", symbol: "NASDAQ:GOOGL", sector: "テック" },
  { name: "アマゾン", symbol: "NASDAQ:AMZN", sector: "テック" },
  { name: "メタ", symbol: "NASDAQ:META", sector: "テック" },
  { name: "ネットフリックス", symbol: "NASDAQ:NFLX", sector: "テック" },
  { name: "オラクル", symbol: "NYSE:ORCL", sector: "テック" },
  { name: "パランティア", symbol: "NASDAQ:PLTR", sector: "テック" },
  { name: "セールスフォース", symbol: "NYSE:CRM", sector: "テック" },
  { name: "アドビ", symbol: "NASDAQ:ADBE", sector: "テック" },
  { name: "シスコシステムズ", symbol: "NASDAQ:CSCO", sector: "テック" },
  { name: "IBM", symbol: "NYSE:IBM", sector: "テック" },
  { name: "サービスナウ", symbol: "NYSE:NOW", sector: "テック" },
  { name: "インテュイット", symbol: "NASDAQ:INTU", sector: "テック" },
  { name: "ソニーグループ", symbol: "TSE:6758", sector: "テック" },
  { name: "ソフトバンクグループ", symbol: "TSE:9984", sector: "テック" },
  { name: "日立製作所", symbol: "TSE:6501", sector: "テック" },
  { name: "富士通", symbol: "TSE:6702", sector: "テック" },
  { name: "リクルート", symbol: "TSE:6098", sector: "テック" },
  { name: "キーエンス", symbol: "TSE:6861", sector: "テック" },
  // 通信
  { name: "AT&T", symbol: "NYSE:T", sector: "通信" },
  { name: "ベライゾン", symbol: "NYSE:VZ", sector: "通信" },
  { name: "Tモバイル", symbol: "NASDAQ:TMUS", sector: "通信" },
  { name: "NTT", symbol: "TSE:9432", sector: "通信" },
  { name: "KDDI", symbol: "TSE:9433", sector: "通信" },
  { name: "ソフトバンク", symbol: "TSE:9434", sector: "通信" },
  // 自動車
  { name: "テスラ", symbol: "NASDAQ:TSLA", sector: "自動車" },
  { name: "GM", symbol: "NYSE:GM", sector: "自動車" },
  { name: "フォード", symbol: "NYSE:F", sector: "自動車" },
  { name: "トヨタ自動車", symbol: "TSE:7203", sector: "自動車" },
  { name: "ホンダ", symbol: "TSE:7267", sector: "自動車" },
  { name: "日産自動車", symbol: "TSE:7201", sector: "自動車" },
  { name: "スズキ", symbol: "TSE:7269", sector: "自動車" },
  { name: "SUBARU", symbol: "TSE:7270", sector: "自動車" },
  // 金融
  { name: "JPモルガン", symbol: "NYSE:JPM", sector: "金融" },
  { name: "バンク・オブ・アメリカ", symbol: "NYSE:BAC", sector: "金融" },
  { name: "ビザ", symbol: "NYSE:V", sector: "金融" },
  { name: "マスターカード", symbol: "NYSE:MA", sector: "金融" },
  { name: "ウェルズ・ファーゴ", symbol: "NYSE:WFC", sector: "金融" },
  { name: "ゴールドマン・サックス", symbol: "NYSE:GS", sector: "金融" },
  { name: "モルガン・スタンレー", symbol: "NYSE:MS", sector: "金融" },
  { name: "アメックス", symbol: "NYSE:AXP", sector: "金融" },
  { name: "三菱UFJ", symbol: "TSE:8306", sector: "金融" },
  { name: "三井住友FG", symbol: "TSE:8316", sector: "金融" },
  { name: "みずほFG", symbol: "TSE:8411", sector: "金融" },
  { name: "オリックス", symbol: "TSE:8591", sector: "金融" },
  { name: "東京海上HD", symbol: "TSE:8766", sector: "金融" },
  // ヘルスケア
  { name: "イーライリリー", symbol: "NYSE:LLY", sector: "ヘルスケア" },
  { name: "ユナイテッドヘルス", symbol: "NYSE:UNH", sector: "ヘルスケア" },
  { name: "ジョンソン&ジョンソン", symbol: "NYSE:JNJ", sector: "ヘルスケア" },
  { name: "メルク", symbol: "NYSE:MRK", sector: "ヘルスケア" },
  { name: "アッヴィ", symbol: "NYSE:ABBV", sector: "ヘルスケア" },
  { name: "ファイザー", symbol: "NYSE:PFE", sector: "ヘルスケア" },
  { name: "サーモフィッシャー", symbol: "NYSE:TMO", sector: "ヘルスケア" },
  { name: "アボット", symbol: "NYSE:ABT", sector: "ヘルスケア" },
  { name: "第一三共", symbol: "TSE:4568", sector: "ヘルスケア" },
  { name: "武田薬品", symbol: "TSE:4502", sector: "ヘルスケア" },
  { name: "中外製薬", symbol: "TSE:4519", sector: "ヘルスケア" },
  { name: "シスメックス", symbol: "TSE:6869", sector: "ヘルスケア" },
  // 生活必需
  { name: "P&G", symbol: "NYSE:PG", sector: "生活必需" },
  { name: "コカ・コーラ", symbol: "NYSE:KO", sector: "生活必需" },
  { name: "ペプシコ", symbol: "NASDAQ:PEP", sector: "生活必需" },
  { name: "モンデリーズ", symbol: "NASDAQ:MDLZ", sector: "生活必需" },
  { name: "コルゲート", symbol: "NYSE:CL", sector: "生活必需" },
  { name: "ウォルマート", symbol: "NYSE:WMT", sector: "生活必需" },
  { name: "コストコ", symbol: "NASDAQ:COST", sector: "生活必需" },
  { name: "JT", symbol: "TSE:2914", sector: "生活必需" },
  { name: "味の素", symbol: "TSE:2802", sector: "生活必需" },
  { name: "アサヒGHD", symbol: "TSE:2502", sector: "生活必需" },
  { name: "セブン&アイ", symbol: "TSE:3382", sector: "生活必需" },
  // 消費（一般消費財）
  { name: "マクドナルド", symbol: "NYSE:MCD", sector: "消費" },
  { name: "ナイキ", symbol: "NYSE:NKE", sector: "消費" },
  { name: "スターバックス", symbol: "NASDAQ:SBUX", sector: "消費" },
  { name: "ホーム・デポ", symbol: "NYSE:HD", sector: "消費" },
  { name: "ロウズ", symbol: "NYSE:LOW", sector: "消費" },
  { name: "ブッキング", symbol: "NASDAQ:BKNG", sector: "消費" },
  { name: "任天堂", symbol: "TSE:7974", sector: "消費" },
  { name: "ファーストリテイリング", symbol: "TSE:9983", sector: "消費" },
  { name: "ZOZO", symbol: "TSE:3092", sector: "消費" },
  { name: "イオン", symbol: "TSE:8267", sector: "消費" },
  // 資本財
  { name: "キャタピラー", symbol: "NYSE:CAT", sector: "資本財" },
  { name: "ハネウェル", symbol: "NASDAQ:HON", sector: "資本財" },
  { name: "GEエアロスペース", symbol: "NYSE:GE", sector: "資本財" },
  { name: "ボーイング", symbol: "NYSE:BA", sector: "資本財" },
  { name: "UPS", symbol: "NYSE:UPS", sector: "資本財" },
  { name: "RTX", symbol: "NYSE:RTX", sector: "資本財" },
  { name: "ロッキード・マーチン", symbol: "NYSE:LMT", sector: "資本財" },
  { name: "ディア", symbol: "NYSE:DE", sector: "資本財" },
  { name: "コマツ", symbol: "TSE:6301", sector: "資本財" },
  { name: "ダイキン工業", symbol: "TSE:6367", sector: "資本財" },
  { name: "三菱重工業", symbol: "TSE:7011", sector: "資本財" },
  { name: "ファナック", symbol: "TSE:6954", sector: "資本財" },
  { name: "SMC", symbol: "TSE:6273", sector: "資本財" },
  // エネルギー
  { name: "エクソンモービル", symbol: "NYSE:XOM", sector: "エネルギー" },
  { name: "シェブロン", symbol: "NYSE:CVX", sector: "エネルギー" },
  { name: "コノコフィリップス", symbol: "NYSE:COP", sector: "エネルギー" },
  { name: "INPEX", symbol: "TSE:1605", sector: "エネルギー" },
  { name: "ENEOS HD", symbol: "TSE:5020", sector: "エネルギー" },
  // 素材
  { name: "リンデ", symbol: "NASDAQ:LIN", sector: "素材" },
  { name: "シャーウィン・ウィリアムズ", symbol: "NYSE:SHW", sector: "素材" },
  { name: "信越化学", symbol: "TSE:4063", sector: "素材" },
  { name: "日本製鉄", symbol: "TSE:5401", sector: "素材" },
  // 公益
  { name: "ネクステラ", symbol: "NYSE:NEE", sector: "公益" },
  { name: "デューク・エナジー", symbol: "NYSE:DUK", sector: "公益" },
  { name: "サザン", symbol: "NYSE:SO", sector: "公益" },
  // 不動産
  { name: "プロロジス", symbol: "NYSE:PLD", sector: "不動産" },
  { name: "アメリカン・タワー", symbol: "NYSE:AMT", sector: "不動産" },
  { name: "エクイニクス", symbol: "NASDAQ:EQIX", sector: "不動産" },
  { name: "三井不動産", symbol: "TSE:8801", sector: "不動産" },
  { name: "三菱地所", symbol: "TSE:8802", sector: "不動産" },
  // 商社
  { name: "伊藤忠商事", symbol: "TSE:8001", sector: "商社" },
  { name: "三菱商事", symbol: "TSE:8058", sector: "商社" },
  { name: "三井物産", symbol: "TSE:8031", sector: "商社" },
  { name: "住友商事", symbol: "TSE:8053", sector: "商社" },
  // ETF
  { name: "半導体ETF(SMH)", symbol: "NASDAQ:SMH", sector: "ETF" },
  { name: "ナスダック100(QQQ)", symbol: "NASDAQ:QQQ", sector: "ETF" }
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
    // クオリティ因子の素データ（ROE・負債資本倍率・純利益率）
    const roe = fd.returnOnEquity && fd.returnOnEquity.raw;
    const debt = fd.debtToEquity && fd.debtToEquity.raw;
    const margin = fd.profitMargins && fd.profitMargins.raw;
    return { analystUp, recMean: recMean != null ? recMean : null, earningsInDays, sectorName,
      roe: roe != null ? roe : null, debt: debt != null ? debt : null, margin: margin != null ? margin : null };
  } catch (e) { return {}; }
}
// コーポレートアクション（配当・株式分割）を sinceISO 以降について取得する。
// 返り値: { divs: [{t(秒), amount(1株あたり・現地通貨)}], splits: [{t, num, den}] }
async function corporateActions(symbol, sinceISO) {
  if (symbol.startsWith("FUND:")) return { divs: [], splits: [] };
  const code = symbol.startsWith("TSE:") ? symbol.slice(4) + ".T" : symbol.split(":")[1];
  const p1 = Math.floor(new Date(sinceISO + "T00:00:00Z").getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}?period1=${p1}&period2=${p2}&interval=1d&events=div,split`, { headers: { "User-Agent": UA } });
    if (!r.ok) return { divs: [], splits: [] };
    const ev = ((((await r.json()).chart || {}).result || [])[0] || {}).events || {};
    const divs = Object.values(ev.dividends || {}).map(d => ({ t: d.date, amount: d.amount })).filter(d => d.t > p1);
    const splits = Object.values(ev.splits || {}).map(s => ({ t: s.date, num: s.numerator, den: s.denominator })).filter(s => s.t > p1);
    return { divs, splits };
  } catch (e) { return { divs: [], splits: [] }; }
}
function zscores(arr) {
  const v = arr.filter(x => x != null && isFinite(x));
  if (v.length < 2) return arr.map(() => 0);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
  return arr.map(x => (x != null && isFinite(x)) ? (x - m) / sd : null);
}
// バックテスト(2024-05〜2026-07・独立半期OOS)で、価格因子はvalue/lowVol偏重→momentum/trend寄りが前後半とも指数超え、
// value/lowVol偏重は両半期で指数負けと判明。中庸傾斜としてmomentum/trendを増やしvalue/lowVol/quality/ratingを削減。
const WEIGHTS = { momentum: 0.20, trend: 0.15, analystUp: 0.15, rating: 0.05, value: 0.16, lowVol: 0.11, quality: 0.18 };
// 低ボラ因子の下限: これ未満の日次ボラ（債券・現金同等ETF等）は同じ扱いにし、"低ボラなだけ"で突出させない
const VOL_FLOOR = 0.012;
// これ未満の日次ボラは株ではあり得ない（債券・現金同等）とみなし、注目銘柄から除外する定量ガード
const VOL_MIN = 0.005;
const isFinancial = c => /金融|Financial/i.test(c.sectorName || c.sector || "");
function scoreAndSelect(cands, opts) {
  const maxPerSector = (opts && opts.maxPerSector) || 2;
  const topN = (opts && opts.topN) || 4;
  const mom = cands.map(c => (c.ret3m != null && c.ret6m != null) ? 0.5 * c.ret3m + 0.5 * c.ret6m : null);
  const up = cands.map(c => c.analystUp != null ? c.analystUp : null);
  const val = cands.map(c => c.posInRange != null ? (1 - c.posInRange) : null);
  const vol = cands.map(c => c.vol != null ? Math.max(c.vol, VOL_FLOOR) : null);
  const rating = cands.map(c => c.recMean != null ? (3 - c.recMean) : null);
  // クオリティ因子: ROE高・利益率高・低負債（銀行等の金融は本質的に高レバなので負債は使わない）
  const zRoe = zscores(cands.map(c => c.roe != null ? c.roe : null));
  const zDebt = zscores(cands.map(c => c.debt != null ? c.debt : null));
  const zMargin = zscores(cands.map(c => c.margin != null ? c.margin : null));
  const qual = cands.map((c, i) => {
    const q = [];
    if (zRoe[i] != null) q.push(zRoe[i]);
    if (zMargin[i] != null) q.push(zMargin[i]);
    if (!isFinancial(c) && zDebt[i] != null) q.push(-zDebt[i]);
    return q.length ? q.reduce((a, b) => a + b, 0) / q.length : null;
  });
  const zMom = zscores(mom), zUp = zscores(up), zVal = zscores(val), zVol = zscores(vol), zRating = zscores(rating);
  const scored = cands.map((c, i) => {
    const trend = ((c.price > c.sma50 ? 0.5 : 0) + (c.sma50 > c.sma200 ? 0.5 : 0));
    const parts = [
      ["momentum", zMom[i]],
      ["trend", trend * 2 - 1],
      ["analystUp", zUp[i]],
      ["rating", zRating[i]],
      ["value", zVal[i]],
      ["lowVol", zVol[i] != null ? -zVol[i] : null],
      ["quality", qual[i]]
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
// 銘柄シンボル＋日付から決定的に言い回しを選ぶ（同じ銘柄でも日によって味変。ランダムすぎない）
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
const variant = (arr, seed) => arr[hashStr(seed) % arr.length];
// 購入根拠: 銘柄の強い因子を見つけ、その性格に合わせた文面を組む（定型の羅列を避ける）
function buildReason(c) {
  const seed = (c.symbol || "") + (typeof todayISO !== "undefined" ? todayISO : "");
  const traits = [];
  if (c.posInRange != null && c.posInRange < 0.4) traits.push({ w: 0.5 - c.posInRange, t: variant([
    `52週レンジ下位${Math.round(c.posInRange * 100)}%まで売られ、割安圏で拾える`,
    `高値から大きく調整し、バリュー妙味が出ている`,
    `年間の安値近辺で、値ごろ感からの反発余地`], seed + "v") });
  if (c.roe != null && c.roe > 0.15) traits.push({ w: Math.min(c.roe, 0.6), t: variant([
    `ROE${Math.round(c.roe * 100)}%と稼ぐ力が高く、業績の裏付けがある`,
    `自己資本利益率${Math.round(c.roe * 100)}%の高収益体質`,
    `本業の利益率が高く、株価の下支えになる強さ`], seed + "q") });
  if (c.ret6m != null && c.ret6m > 0.12 && c.price > c.sma50) traits.push({ w: Math.min(c.ret6m, 1), t: variant([
    `直近半年で${pct(c.ret6m)}と明確な上昇トレンド`,
    `50日・200日線を上回り、買いの勢いが続く`,
    `中期の値動きが右肩上がりで地合い良好`], seed + "m") });
  if (c.analystUp != null && c.analystUp > 0.12) traits.push({ w: Math.min(c.analystUp, 0.6), t: variant([
    `アナリスト平均目標まで${pct(c.analystUp)}、市場はまだ上値を見込む`,
    `証券会社の目標株価に対し${pct(c.analystUp)}の余地`,
    `プロの見立てでは割安で、見直し買いの余地`], seed + "a") });
  if (c.vol != null && c.vol < 0.015) traits.push({ w: 0.02 - c.vol, t: variant([
    `値動きが穏やかで下振れ耐性が比較的高い`,
    `ボラティリティが低く腰を据えて持ちやすい`], seed + "l") });
  if (!traits.length) traits.push({ w: 1, t: c.price > c.sma50 ? "50日線を上回り短期は堅調" : "複数指標の総合点で相対的に上位" });
  traits.sort((a, b) => b.w - a.w);
  const top = traits.slice(0, 2).map(x => x.t);
  const lead = variant(["決め手は", "注目点は", "今日拾う理由は", "評価したのは"], seed + "h");
  const join = top.length > 1 ? variant(["。加えて", "。さらに", "。そのうえ"], seed + "j") : "";
  const tail = variant(["、という点。", "、あたり。", "、が背景。", "。"], seed + "t");
  const sec = c.sectorName || c.sector;
  return (sec ? `【${sec}】` : "") + lead + top[0] + (join ? join + top[1] : "") + tail;
}
// リスク: 銘柄の性格（過熱／割安トラップ／高負債／セクター）に応じて具体的に
function buildRisk(c) {
  const seed = (c.symbol || "") + (typeof todayISO !== "undefined" ? todayISO : "") + "r";
  const b = [];
  if (c.vol != null && c.vol > 0.03) b.push(variant([
    `日次ボラ${(c.vol * 100).toFixed(1)}%と荒く短期の振れ幅が大きい`,
    `値動きが激しく、含み損益のブレに注意`], seed + "1"));
  if (c.posInRange != null && c.posInRange > 0.9) b.push(variant([
    `52週高値圏で過熱感、材料出尽くしの反落もありうる`,
    `高値追いの局面で利益確定売りに押されやすい`], seed + "2"));
  else if (c.posInRange != null && c.posInRange < 0.2) b.push(variant([
    `安いのには理由があることも。下落トレンドが続けば戻りは鈍い`,
    `割安圏だが、業績悪化が続くと"万年割安"に沈むリスク`], seed + "3"));
  const secText = c.sectorName || c.sector || "";
  if (c.debt != null && c.debt > 150 && !/金融|Financial/i.test(secText)) b.push("負債資本倍率が高く、金利上昇・業績悪化時の財務負担に注意");
  const secRisk =
    /半導体|Semiconductor/i.test(secText) ? "半導体市況（在庫・設備投資サイクル）の反落" :
    /テック|Technology|Communication|通信/i.test(secText) ? "金利上昇時にバリュエーションが縮みやすい" :
    /金融|Financial/i.test(secText) ? "景気後退・金利低下時の利ざや縮小や与信費用" :
    /エネルギー|Energy/i.test(secText) ? "原油・ガス価格の急変" :
    /ヘルスケア|Health/i.test(secText) ? "治験結果・薬価改定・規制の影響" :
    /生活必需|Defensive/i.test(secText) ? "ディフェンシブゆえ相場上昇局面では出遅れやすい" :
    /消費|Consumer|Cyclical/i.test(secText) ? "景気減速による消費の冷え込み" :
    /素材|Material|Basic/i.test(secText) ? "市況（原材料価格）と世界景気の影響" :
    /資本財|Industrial/i.test(secText) ? "設備投資の停滞・受注減" :
    /不動産|Real Estate/i.test(secText) ? "金利上昇による不動産価値・調達コストの悪化" :
    /公益|Utilit/i.test(secText) ? "金利敏感（債券代替）で金利上昇に弱い" :
    /自動車/i.test(secText) ? "為替・EV競争・関税の影響を受けやすい" : null;
  if (secRisk) b.push(secRisk);
  const generic = ["ピーク比-35%の暴落ストップで大崩れは限定する想定", "相場全体の急変には勝てない点に留意"];
  if (!(c.symbol || "").startsWith("TSE:")) generic.push("円高は円建て評価の逆風"); // 米国株のみ
  b.push(variant(generic, seed + "z"));
  return b.join("。") + "。";
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
// ===== 採用: 二段階採点 → 決算±3日回避・低ボラ(債券)ガードのみ。分散は買付時の金額シェアで制御 =====
// 偏りは「件数」ではなく買付時のセクター/銘柄の評価額シェア上限で抑える（積立額が増えても現金滞留しない）。
const TOP_N = 12, POOL_N = 40;
const sectorBucket = (sector) => (sector && /投信|FUND/.test(sector)) ? "投信" : (sector || "その他");
function heldSymbols() {
  try { const pf = JSON.parse(fs.readFileSync(PF_FILE, "utf8")); return new Set((pf.open || []).map(p => p.symbol)); } catch (e) { return new Set(); }
}
async function adoptWithConstraints(ranked) {
  const held = heldSymbols();
  // Stage-1上位POOL_N ∪ 保有銘柄（rankedにある分）をプールに。保有もStage-2採点して買い増し判定に使う。
  const pool = ranked.slice(0, POOL_N);
  const inPool = new Set(pool.map(c => c.symbol));
  for (const c of ranked) if (held.has(c.symbol) && !inPool.has(c.symbol)) { pool.push(c); inPool.add(c.symbol); }
  // Stage-2: 全指標を取得。モメンタムは「50/200日線からの乖離」ではなくチャートの真の3/6ヶ月リターンで上書き
  // （trend・value因子との重複を解消。④）。レバETFは倍率で割って公平化。
  for (const c of pool) {
    Object.assign(c, await enrichExtra(c.symbol));
    const m = await chartMetrics(c.symbol);
    if (m) {
      const lev = c.lev || 1;
      if (m.ret3m != null) c.ret3m = m.ret3m / lev;
      if (m.ret6m != null) c.ret6m = m.ret6m / lev;
      if (m.sma50 != null) c.sma50 = m.sma50;
      if (m.sma200 != null) c.sma200 = m.sma200;
      if (m.posInRange != null) c.posInRange = m.posInRange;
      if (m.vol != null) c.vol = m.vol;
      if (m.atrRatio != null) c.atrRatio = m.atrRatio;
      if (m.price != null) c.price = m.price;
    }
    await sleep(150);
  }
  // Stage-2: 全因子（value/lowVol/quality/analystUp/rating込み）で再採点して並べ替え
  const rescored = scoreAndSelect(pool, { maxPerSector: 9999, topN: pool.length });
  // 買い候補の採用（決算回避・低ボラガード）
  const picks = [];
  for (const c of rescored) {
    if (c.earningsInDays != null && c.earningsInDays >= -1 && c.earningsInDays <= 3) {
      console.log("決算近接でスキップ:", c.name, `(${c.earningsInDays}日後)`); continue;
    }
    if (c.vol != null && c.vol < VOL_MIN) { console.log("低ボラ過ぎ(債券/現金相当)でスキップ:", c.name, `(${(c.vol*100).toFixed(2)}%/日)`); continue; }
    c.sector = c.sectorName || c.sector || null; // 買付側のシェア判定で使うセクターを確定
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
    // インバース（ベア）型ETFは除外。ブル（レバレッジ）型は倍率でモメンタムを割って公平に比較
    // （倍率調整により、同じ指数ならレバなし版よりも減価の分だけ自然に不利になる）
    let lev = 1;
    if (u.etf) {
      const nm = u.name || "";
      if (/(inverse|インバース|ベア|\bbear\b|\bshort\b|-1x)/i.test(nm)) continue;
      // 債券・国債・現金同等（マネーマーケット等）ETFは株の「注目銘柄」に馴染まないため除外。
      // スクリーナーの銘柄名は途中で切れることがある（"...Investment Gra"）ので、満期レンジ表記や
      // "investment gra"/"corporate" 等の断片でも拾えるようにする。
      if (/bond|treasury|t-bill|gilt|bund|\bjgb\b|municipal|aggregate|fixed income|money market|ultrashort|\btips\b|investment gra|corporate|\d\s*[-–]\s*\d+\s*year|\d+\s*\+\s*year|債券|国債|公社債/i.test(nm)) continue;
      if (/(3x|３倍|ultrapro)/i.test(nm)) lev = 3;
      else if (/(2x|２倍|レバレッジ|\bultra\b|ブル|\bbull\b|leveraged)/i.test(nm)) lev = 2;
    }
    if (price * vol < (jpy ? 1e9 : 1e7)) continue;   // 1日売買代金 約10億円 / 1000万ドル 以上
    cands.push({
      name: u.name, symbol: u.symbol, sector: u.etf ? "ETF" : null, lev, price, sma50: ma50, sma200: ma200,
      posInRange: (price - lo) / (hi - lo), ret3m: (price / ma50 - 1) / lev, ret6m: (price / ma200 - 1) / lev, vol: null,
      mcDisp: u.etf ? (lev > 1 ? `ブル${lev}倍ETF（スコアは倍率で調整済み）` : "ETF")
                    : (jpy ? `時価総額${Math.round(mc / 1e8)}億円` : `時価総額${(mc / 1e9).toFixed(0)}十億ドル`)
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
  return picks.map(t => ({ name: t.name, symbol: t.symbol, sector: t.sectorName || t.sector || null, reason: buildReason(t), risk: buildRisk(t) }));
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
  let pf = { investedJPY: 0, realizedJPY: 0, taxPaidJPY: 0, feesPaidJPY: 0, dividendsJPY: 0, open: [], closed: [], lastBuyDate: null };
  try { pf = JSON.parse(fs.readFileSync(PF_FILE, "utf8")); } catch (e) {}
  if (pf.taxPaidJPY == null) pf.taxPaidJPY = 0;
  if (pf.feesPaidJPY == null) pf.feesPaidJPY = 0;
  if (pf.dividendsJPY == null) pf.dividendsJPY = 0;

  const symbols = new Set([...pf.open.map(p => p.symbol), ...out.picks.map(p => p.symbol)]);
  const priceJPY = {};
  for (const s of symbols) {
    try { priceJPY[s] = await toJPY(await yQuote(s)); } catch (e) { console.log("価格取得失敗:", s, e.message); }
  }

  const TAX_RATE = 0.20315; // 譲渡益・配当への課税（所得税15%＋復興0.315%＋住民5%）
  const COST_RATE = 0.002;  // 売買コスト（片道0.2%：手数料＋為替スプレッド相当）

  // ===== 配当・株式分割の反映（必ず売却判定の前に処理する）=====
  // 分割: 口数・取得単価・ピークを比率調整（未対応だと分割時に評価額が急落し誤売却するため）。
  // 配当: 税引後を待機資金へ→翌朝再投資（オルカンは基準価額に配当が含まれるため、公平性のために必須）。
  let usdjpyRate = 0;
  for (const pos of pf.open) {
    if (pos.symbol.startsWith("FUND:")) { pos.actionsThru = todayISO; continue; }
    const since = pos.actionsThru || pos.buyDate;
    if (since >= todayISO) { pos.actionsThru = todayISO; continue; } // 当日購入分などは処理対象なし
    let ca; try { ca = await corporateActions(pos.symbol, since); } catch (e) { ca = { divs: [], splits: [] }; }
    for (const s of ca.splits.sort((a, b) => a.t - b.t)) {
      const f = (s.num && s.den) ? s.num / s.den : null;
      if (f && isFinite(f) && f > 0) {
        pos.units *= f;
        if (pos.buyPriceJPY) pos.buyPriceJPY = Math.round((pos.buyPriceJPY / f) * 100) / 100;
        if (pos.peakJPY) pos.peakJPY = pos.peakJPY / f;
        console.log("株式分割を反映:", pos.name, `${s.num}:${s.den}`);
      }
    }
    let posDiv = 0;
    for (const d of ca.divs) {
      if (d.amount == null) continue;
      let jpy = d.amount * pos.units;
      if (!pos.symbol.startsWith("TSE:")) { if (!usdjpyRate) usdjpyRate = await toJPY({ currency: "USD", price: 1 }); jpy *= usdjpyRate; }
      posDiv += jpy;
    }
    if (posDiv > 0) {
      const dtax = Math.round(posDiv * TAX_RATE * 10) / 10;
      const net = Math.round((posDiv - dtax) * 10) / 10;
      pf.dividendsJPY = Math.round((pf.dividendsJPY + posDiv) * 10) / 10;
      pf.taxPaidJPY = Math.round((pf.taxPaidJPY + dtax) * 10) / 10;
      pf.cashJPY = Math.round(((pf.cashJPY || 0) + net) * 10) / 10;
      console.log("配当受取(税引後再投資):", pos.name, `${Math.round(posDiv)}円(税${dtax}円)`);
    }
    pos.actionsThru = todayISO;
  }

  // ===== 売却判定: ①暴落ストップ(ピーク比-35%・毎日) ②分散トリム(月1回) =====
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  // 部分/全部売却の共通処理: 手数料・税を計上し closed に記録、pos の units/cost を減らす。全部売れたら true。
  const realizeSell = (pos, pj, sellUnits, reason) => {
    sellUnits = Math.min(sellUnits, pos.units);
    if (!(sellUnits > 0)) return false;
    const v = sellUnits * pj;
    const fee = Math.round(v * COST_RATE * 10) / 10;
    const costPortion = pos.costJPY * (sellUnits / pos.units);
    const gain = v - costPortion;
    const tax = gain > 0 ? Math.round(gain * TAX_RATE * 10) / 10 : 0; // 利益にのみ課税（簡易・損益通算なし）
    const net = Math.round((v - fee - tax) * 10) / 10;
    pf.realizedJPY += net;
    pf.taxPaidJPY = Math.round((pf.taxPaidJPY + tax) * 10) / 10;
    pf.feesPaidJPY = Math.round((pf.feesPaidJPY + fee) * 10) / 10;
    pf.cashJPY = Math.round(((pf.cashJPY || 0) + net) * 10) / 10;
    pf.closed.push({ symbol: pos.symbol, name: pos.name, sector: pos.sector || null, buyDate: pos.buyDate,
      units: sellUnits, costJPY: Math.round(costPortion * 10) / 10, sellDate: todayISO,
      sellValueJPY: Math.round(v * 10) / 10, feeJPY: fee, taxJPY: tax, netJPY: net, sellReason: reason });
    pos.units -= sellUnits;
    pos.costJPY = Math.round((pos.costJPY - costPortion) * 10) / 10;
    console.log("売却:", pos.name, reason, `${Math.round(v)}円`, tax > 0 ? `(税${tax})` : "");
    return pos.units <= 1e-9;
  };

  // ① 暴落限定ストップ（ピーク比 -35%固定）。日次ATRトレーリング(12〜28%)はバックテストで上昇相場の
  //    「押し目売り→高値買い直し→課税」whipsawがnet有害(費用の大半)と判明したため、大暴落だけ拾う広い固定%に置換。
  const HARD_STOP = 0.35;
  let still = [];
  for (const pos of pf.open) {
    const pj = priceJPY[pos.symbol];
    if (pj == null) { still.push(pos); continue; } // 価格が取れない日は保有継続
    pos.peakJPY = Math.max(pos.peakJPY || pos.buyPriceJPY, pj);
    pos.trailPct = HARD_STOP * 100; // 表示用(%)
    if (pj <= pos.peakJPY * (1 - HARD_STOP)) realizeSell(pos, pj, pos.units, `暴落ストップ(ピーク比-${pos.trailPct}%)`);
    else still.push(pos);
  }
  pf.open = still;

  // ② 分散トリム（月1回）: 値上がりで肥大化した銘柄/セクターを上限まで一部利確（35%/15%の分散を維持）。
  // バックテストで日次トリムより月次の方が税・手数料が減りDDは同等と判明。旧③スコア悪化エグジットは撤去済み。
  const doTrim = (pf.lastTrimMonth !== todayISO.slice(0, 7));
  if (doTrim) pf.lastTrimMonth = todayISO.slice(0, 7);
  if (doTrim) {
    const NAME_HARD = 0.20, NAME_TGT = 0.15, SECTOR_HARD = 0.45, SECTOR_TGT = 0.40, DIVERSIFY_BASE = 20000;
    const cvOf = p => { const pj = priceJPY[p.symbol]; return pj != null ? p.units * pj : 0; };
    const priced = () => pf.open.filter(p => priceJPY[p.symbol] != null);
    // 分母は総資産（保有＋待機資金）。ただし規模が小さいうちは DIVERSIFY_BASE で緩和（保有数が少ない初期に過剰トリムしない）。
    // トリムは保有→現金へ移すだけで総資産は不変なので sellVal = groupVal - tgt×total
    const portTotal = () => Math.max(priced().reduce((s, p) => s + cvOf(p), 0) + (pf.cashJPY || 0), DIVERSIFY_BASE);
    const trimGroup = (positions, groupVal, total, hard, tgt, label) => {
      if (total <= 0 || groupVal <= hard * total) return;
      let sellVal = groupVal - tgt * total;
      for (const p of positions.slice().sort((a, b) => cvOf(b) - cvOf(a))) {
        if (sellVal <= 1) break;
        const pj = priceJPY[p.symbol]; if (pj == null) continue;
        const take = Math.min(sellVal, p.units * pj);
        realizeSell(p, pj, take / pj, label);
        sellVal -= take;
      }
    };
    // 単一銘柄（総資産比で20%超→15%へ）
    let total = portTotal();
    const bySym = {}; for (const p of priced()) (bySym[p.symbol] = bySym[p.symbol] || []).push(p);
    for (const sym in bySym) trimGroup(bySym[sym], bySym[sym].reduce((s, p) => s + cvOf(p), 0), total, NAME_HARD, NAME_TGT, `分散トリム(単一銘柄${NAME_HARD * 100}%超)`);
    // セクター（総資産比で45%超→40%へ。銘柄トリム後の各セクター値で判定）
    total = portTotal();
    const bySec = {}; for (const p of priced()) { const b = sectorBucket(p.sector); (bySec[b] = bySec[b] || []).push(p); }
    for (const b in bySec) trimGroup(bySec[b], bySec[b].reduce((s, p) => s + cvOf(p), 0), total, SECTOR_HARD, SECTOR_TGT, `分散トリム(${b}が${SECTOR_HARD * 100}%超)`);
  }
  pf.open = pf.open.filter(p => p.units > 1e-9); // 端数で0になったポジションを除去

  // ===== 積立（毎日）と仮想購入（週1回）=====
  // 積立4000円は毎日、待機資金へ加算（ベンチのオルカンも毎日4000円積立なので同条件）。
  // 購入は週1回、貯まった待機資金をまとめて配分。バックテストで、日次でスコア上位を追い続けるより
  // 週次でまとめ買う方が高値掴み・即トリムのchurnが減り、買い曜日に依らず安定して優位と判明したため。
  if (pf.lastContribDate !== todayISO) {
    pf.cashJPY = Math.round(((pf.cashJPY || 0) + 4000) * 10) / 10;
    pf.investedJPY += 4000;                      // 新規入金分のみ（毎日計上・再投資分は二重計上しない）
    pf.lastContribDate = todayISO;
  }
  let boughtToday = null;
  const daysSinceBuy = pf.lastBuyDate ? (new Date(todayISO) - new Date(pf.lastBuyDate)) / 86400000 : 999;
  if (daysSinceBuy >= 7 && pf.lastBuyDate !== todayISO) {  // 前回買付から7日以上＝週1回。休みで飛んでも次の実行日にまとめて投下
    const LOT = 1000, SECTOR_CAP = 0.35, NAME_CAP = 0.15, DIVERSIFY_BASE = 20000;
    let cash = (pf.cashJPY || 0);                // 4000は上の積立で加算済み
    const curVal = p => { const pj = priceJPY[p.symbol]; return pj != null ? p.units * pj : p.costJPY; };
    let total = pf.open.reduce((s, p) => s + curVal(p), 0);
    const secVal = {}, symVal = {};
    for (const p of pf.open) { const b = sectorBucket(p.sector); secVal[b] = (secVal[b] || 0) + curVal(p); symVal[p.symbol] = (symVal[p.symbol] || 0) + curVal(p); }
    const cands = out.picks.filter(p => priceJPY[p.symbol] != null);
    const allocLots = {};
    const tryPlace = spreadOnly => {
      for (const p of cands) {
        if (spreadOnly && (allocLots[p.symbol] || 0) >= 1) continue; // 第1段階は1銘柄1ロットまで
        const b = sectorBucket(p.sector), base = Math.max(total + LOT, DIVERSIFY_BASE);
        if ((secVal[b] || 0) + LOT > SECTOR_CAP * base) continue;      // セクター評価額シェア上限
        if ((symVal[p.symbol] || 0) + LOT > NAME_CAP * base) continue; // 単一銘柄評価額シェア上限
        allocLots[p.symbol] = (allocLots[p.symbol] || 0) + 1;
        secVal[b] += LOT; symVal[p.symbol] = (symVal[p.symbol] || 0) + LOT;
        total += LOT; cash -= LOT; return true;
      }
      return false;
    };
    let lots = Math.floor(cash / LOT), guard = 0;
    while (lots > 0 && guard++ < 5000 && tryPlace(true)) lots--;   // ①分散優先
    while (lots > 0 && guard++ < 5000 && tryPlace(false)) lots--;  // ②買い増し
    const alloc = {};
    for (const p of cands) {
      const n = allocLots[p.symbol]; if (!n) continue;
      const amt = n * LOT; alloc[p.symbol] = amt;
      const pj = priceJPY[p.symbol];
      const fee = Math.round(amt * COST_RATE * 10) / 10;            // 買付コスト（片道）
      pf.feesPaidJPY = Math.round((pf.feesPaidJPY + fee) * 10) / 10;
      pf.open.push({
        symbol: p.symbol, name: p.name, sector: p.sector || null, buyDate: todayISO,
        units: (amt - fee) / pj, buyPriceJPY: Math.round(pj * 100) / 100, peakJPY: pj, costJPY: amt, actionsThru: todayISO
      });
      console.log("購入:", p.name, amt + "円", `(コスト${fee}円)`);
    }
    pf.cashJPY = Math.round(cash * 10) / 10;     // 上限で置けなかった分・端数は待機資金として翌週へ繰越
    pf.lastBuyDate = todayISO;
    boughtToday = alloc;
  }
  // サイトに表示する注目銘柄は実際に買った銘柄（買いのない再実行日は上位4件）
  if (boughtToday && Object.keys(boughtToday).length) {
    out.picks = out.picks.filter(p => boughtToday[p.symbol]);
  } else {
    out.picks = out.picks.slice(0, 4);
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
  pf.valuationJPY = Math.round(((pf.cashJPY || 0) + openValue) * 10) / 10; // 評価額＝待機資金＋保有分
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
