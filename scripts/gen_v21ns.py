#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""analysis_v21ns.json 生成スクリプト（V2.1-NS 因子スコア・ローカル実行用）

index.html の「銘柄別デスク画面」が読み込む静的 JSON を生成する。
Yahoo Finance の chart API（日足2年）だけを使い、V2.1-NS の 4 因子を計算する:

    mom    = 0.5*ret63 + 0.5*ret126
    trend  = (終値>SMA50 ? .5:0) + (SMA50>SMA200 ? .5:0)
    value  = 1 - pos            （pos = 52週レンジ内の位置）
    lowvol = -(60日の日次ボラ)

各因子をユニバース横断で z 化し

    score = .35*z_mom + .25*(trend*2-1) + .22*z_value + .18*z_lowvol

ノーセル運用なので「売り」は存在しない。

ユニバースは2層
----------------
- **選抜層**（`selection_universe: true`）: update_analysis.mjs の固定リスト＋
  portfolio.json の保有＋index.html の初期リスト（約148銘柄）。
  **top12 の選抜はこの層の中だけで行う**——チャンピオン V2.1 の定義を変えないため。
- **分析層**（`selection_universe: false`）: `--big` で渡す universe_big.json 側にしか
  居ない銘柄。z スコアと `rank` は全銘柄横断で計算するが `in_top12` は必ず false。
  フロントは「参考値（選抜対象外）」として表示する。
`selection_rank` は選抜層内での順位（分析層は null）。

universe_big.json はリポジトリ外に置き、コミットしない（パスは CLI 引数で受け取る）。

comment / ai フィールドについて
------------------------------
comment と ai（AIの見立て）は **このスクリプトでは生成しない**。課金 API は
一切呼ばず、Claude セッション（サブスク範囲）が後から書き込む運用
（claude内architecture・2026-08 確定）。

毎朝 cron で JSON を作り直すため、手書き部分は明示的に引き継ぐ必要がある:

  1. `--merge-comments`（既定で有効）… 既存 analysis_v21ns.json の
     comment と ai をそのまま持ち越す。
  2. `--ai-file ai_comments.json` … 外部ファイルの ai で上書きする。
     形式は {"NASDAQ:AAPL": {"stance","reason","risk","written_at"}, ...}。
     ファイルが無ければ 1 の持ち越しだけが効く。

ai.stance は "買い候補" / "様子見" / "判断保留" の3値のみ（ノーセル運用なので
「売り」は存在しない）。未知の値は "判断保留" に倒す。

決算データ
----------
次回決算日・通期/次四半期のアナリスト平均は Yahoo quoteSummary から取得して
JSON に焼き込む（earnings フィールド）。このエンドポイントは cookie+crumb 認証が
必要でブラウザからは 401 になるため、サーバー側であるこのスクリプトが取るしかない
（update_analysis.mjs と同じ手順）。四半期実績（quarters フィールド）は認証不要の
fundamentals-timeseries から 8 期ぶん取得し、YoY 計算に使う。

データ規約
----------
- 全て Yahoo Finance 由来。Sharadar 等の再配布禁止データは一切含めない。
- 指数 CFD（FOREXCOM:*）・FX・投信（FUND:*）は日足が取れないため対象外。

使い方
------
    python3 scripts/gen_v21ns.py --sample     # ネット不要のダミー6銘柄を生成
    python3 scripts/gen_v21ns.py              # 選抜層のみ実データ取得
    python3 scripts/gen_v21ns.py --big ../universe_big.json --sleep 0.6   # 2層フル実走
    python3 scripts/gen_v21ns.py --limit 60   # ユニバースを先頭60銘柄に制限
    # 推奨: ローカル日足キャッシュを一次ソースにして 429 を回避しつつ全ユニバース
    python3 scripts/gen_v21ns.py --big ../universe_big.json \
        --prices /path/to/bt_cache_big_03.json --sleep 0.6

Yahoo chart API は連続アクセスで 429 を返すため、リトライは指数バックオフ
(1s→4s→16s)、429 検知時は 60 秒休止する。進捗は 20 銘柄ごとに
「N/total done, skips=M」形式で stderr に出す。
"""

import argparse
import json
import math
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MJS = os.path.join(ROOT, "scripts", "update_analysis.mjs")
INDEX = os.path.join(ROOT, "index.html")
PORTFOLIO = os.path.join(ROOT, "portfolio.json")
OUT_DEFAULT = os.path.join(ROOT, "analysis_v21ns.json")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"
WEIGHTS = {"mom": 0.35, "trend": 0.25, "value": 0.22, "lowvol": 0.18}
TOPN = 12

# 日足が取れない/意味を持たないシンボル種別
SKIP_PREFIX = ("FOREXCOM:", "FX_IDC:", "FUND:", "BITSTAMP:", "TVC:", "CAPITALCOM:")


# ---------------------------------------------------------------- ユニバース
def to_yahoo(sym):
    """TradingView 形式 'TSE:7974' → Yahoo 形式 '7974.T'。米国株はティッカーのみ。"""
    if sym.startswith("TSE:"):
        return sym[4:] + ".T"
    return sym.split(":")[-1]


def parse_mjs_universe(path):
    """update_analysis.mjs の UNIVERSE 配列を読み取る（読むだけ・編集しない）。"""
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            src = f.read()
    except OSError:
        return out
    m = re.search(r"const UNIVERSE = \[(.*?)\n\];", src, re.S)
    if not m:
        return out
    # フィールド順に依存せず各 {...} からキーを個別に拾う
    # (実物の update_analysis.mjs は { symbol, name, isin, assoc, sector } 順)
    for obj in re.findall(r"\{[^{}]*\}", m.group(1)):
        name = re.search(r'name:\s*"([^"]+)"', obj)
        sym = re.search(r'symbol:\s*"([^"]+)"', obj)
        sector = re.search(r'sector:\s*"([^"]*)"', obj)
        if not (name and sym):
            continue
        if sym.group(1).startswith("FUND:"):
            continue  # 投信はYahoo chart APIに日足が無い
        out.append({"name": name.group(1), "symbol": sym.group(1),
                    "sector": sector.group(1) if sector else ""})
    return out


def parse_index_defaults(path):
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            src = f.read()
    except OSError:
        return out
    m = re.search(r"const DEFAULTS = \[(.*?)\n\];", src, re.S)
    if not m:
        return out
    for name, sym in re.findall(
        r'\{\s*name:\s*"([^"]+)",\s*symbol:\s*"([^"]+)"\s*\}', m.group(1)
    ):
        out.append({"name": name, "symbol": sym, "sector": ""})
    return out


def parse_portfolio_open(path):
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            pf = json.load(f)
    except (OSError, ValueError):
        return out
    for p in pf.get("open", []):
        if p.get("symbol"):
            out.append(
                {
                    "name": p.get("name") or p["symbol"],
                    "symbol": p["symbol"],
                    "sector": p.get("sector", ""),
                }
            )
    return out


def parse_big_universe(path, limit=None):
    """リポジトリ外に置いた universe_big.json（{fetched, list:[{name,symbol,sector}]}）。

    このファイルはリポジトリにコミットしない運用のため、パスは CLI 引数で受け取る。
    """
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        print(f"warn: big universe を読めません: {path}", file=sys.stderr)
        return out
    for it in d.get("list") or []:
        if not it.get("symbol"):
            continue
        out.append(
            {
                "name": it.get("name") or it["symbol"],
                "symbol": it["symbol"],
                "sector": it.get("sector", ""),
            }
        )
    if limit:
        out = out[:limit]
    return out


def build_universe(limit=None, big_path=None, big_limit=None):
    """2層ユニバースを組む。

    - 選抜層（selection_universe=True）: update_analysis.mjs の固定リスト＋保有銘柄＋
      index.html の初期リスト。**top12 の選抜はこの層の中だけで行う**
      （チャンピオン V2.1 の定義を変えないため）。
    - 分析層（selection_universe=False）: universe_big.json 側だけに居る銘柄。
      z スコアと rank は全体で計算するが、選抜（in_top12）の対象にはしない。
    """
    seen, uni = set(), []

    def add(items, selection):
        for it in items:
            sym = it["symbol"]
            if sym in seen or sym.startswith(SKIP_PREFIX):
                continue
            seen.add(sym)
            uni.append({**it, "selection_universe": selection})

    # 先に選抜層を入れる（big 側に同じ銘柄が居ても選抜層の扱いが勝つ）
    add(parse_mjs_universe(MJS), True)
    add(parse_portfolio_open(PORTFOLIO), True)
    add(parse_index_defaults(INDEX), True)
    n_sel = len(uni)
    if big_path:
        add(parse_big_universe(big_path, big_limit), False)
    print(
        f"universe: 選抜層 {n_sel} 銘柄 / 分析のみ {len(uni) - n_sel} 銘柄 = 合計 {len(uni)}",
        file=sys.stderr,
    )
    if limit:
        uni = uni[:limit]
    return uni


# ------------------------------------------------------------------ データ取得
RATE_LIMIT_PAUSE = 60.0  # 429 を踏んだときの休止（秒）
_rate_hits = 0

# 直アクセスが 429 で塞がれたときの迂回路（index.html と同じ無料CORS中継）。
# 中継サーバー側のIPから出るので、こちらのIPのレート制限とは独立に効く。
ROUTES = [
    ("direct-q1", lambda u: u),
    ("direct-q2", lambda u: u.replace("query1.", "query2.")),
    ("allorigins", lambda u: "https://api.allorigins.win/raw?url=" + urllib.parse.quote(u, safe="")),
    ("codetabs", lambda u: "https://api.codetabs.com/v1/proxy?quest=" + urllib.parse.quote(u, safe="")),
    ("corsproxy", lambda u: "https://corsproxy.io/?url=" + urllib.parse.quote(u, safe="")),
]


def _is_rate_limited(e):
    if isinstance(e, urllib.error.HTTPError):
        return e.code in (429, 999) or e.code >= 500
    return False


def _get_json(target, timeout=25):
    """複数経路を順に試して JSON を取る。全滅なら (None, rate_limited?) を返す。"""
    saw_rate_limit = False
    for name, build in ROUTES:
        try:
            req = urllib.request.Request(build(target), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            if not body or body[:1] not in (b"{", b"["):
                continue
            return json.loads(body.decode("utf-8", "replace")), False
        except Exception as e:  # noqa: BLE001
            if _is_rate_limited(e):
                saw_rate_limit = True
    return None, saw_rate_limit


def fetch_chart(ysym, rng="2y", interval="1d", retries=2):
    """Yahoo chart API。429 系は指数バックオフ(1s→4s→16s)＋60秒休止で粘る。

    直アクセスが 429 で塞がれている間は CORS 中継経由に自動で切り替わる。
    """
    global _rate_hits
    target = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(ysym)}?range={rng}&interval={interval}"
    )
    for attempt in range(retries + 1):
        j, limited = _get_json(target)
        if j is not None:
            res = (j.get("chart") or {}).get("result") or []
            if not res:
                return None
            res = res[0]
            ts = res.get("timestamp") or []
            closes = ((res.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
            pts = [
                (t, c)
                for t, c in zip(ts, closes)
                if c is not None and isinstance(c, (int, float)) and c > 0
            ]
            return pts if len(pts) >= 210 else None
        if limited:
            _rate_hits += 1
            print(
                f"  rate-limited (全経路) {ysym} → {RATE_LIMIT_PAUSE:.0f}秒休止",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(RATE_LIMIT_PAUSE)
        if attempt < retries:
            time.sleep(1.0 * (4 ** attempt))  # 1s → 4s → 16s
    return None


# --------------------------------------------- ローカル価格キャッシュ（一次ソース）
_PRICES = None


def load_price_cache(path):
    """研究用のYahoo日足キャッシュ {sym: [[date, close], ...]} を読む。

    Yahoo の chart API はIP単位で 429 に張り付くため、**在るものはここから読む**。
    ファイルは 159MB あるので一度だけ読んでメモリに持つ（repo にはコピーしない）。
    """
    global _PRICES
    if _PRICES is not None:
        return _PRICES
    _PRICES = {}
    if not path:
        return _PRICES
    try:
        with open(path, encoding="utf-8") as f:
            _PRICES = json.load(f)
    except (OSError, ValueError) as e:
        print(f"warn: 価格キャッシュを読めません: {path} ({e})", file=sys.stderr)
        _PRICES = {}
        return _PRICES
    lasts = [v[-1][0] for v in _PRICES.values() if v]
    print(
        f"price cache: {len(_PRICES)} 銘柄 / 最終日 {max(lasts) if lasts else '—'}",
        file=sys.stderr,
        flush=True,
    )
    return _PRICES


def cache_series(ysym, years=2):
    """キャッシュから直近 N 年ぶんを (unixtime, close) の列で返す。無ければ None。"""
    rows = (_PRICES or {}).get(ysym)
    if not rows or len(rows) < 260:
        return None
    cutoff = None
    try:
        last = datetime.strptime(rows[-1][0], "%Y-%m-%d")
        cutoff = (last - timedelta(days=int(365.25 * years) + 10)).strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        pass
    out = []
    for d, c in rows:
        if cutoff and d < cutoff:
            continue
        if c is None or not isinstance(c, (int, float)) or c <= 0:
            continue
        try:
            t = int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
        except (ValueError, TypeError):
            continue
        out.append((t, float(c)))
    return out if len(out) >= 210 else None


def cache_as_of(ysym):
    rows = (_PRICES or {}).get(ysym)
    return rows[-1][0] if rows else None


# ------------------------------------------------- 決算（cookie+crumb が必要）
_CRUMB = None
_OPENER = None


def _opener():
    global _OPENER
    if _OPENER is None:
        import http.cookiejar

        _OPENER = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )
        _OPENER.addheaders = [("User-Agent", UA)]
    return _OPENER


def ensure_crumb():
    """Yahoo の cookie を取ってから crumb を取得（update_analysis.mjs と同じ手順）。"""
    global _CRUMB
    if _CRUMB is not None:
        return _CRUMB
    _CRUMB = ""
    try:
        op = _opener()
        op.open("https://fc.yahoo.com/", timeout=12).read(64)
    except Exception:
        pass
    try:
        with _opener().open(
            "https://query2.finance.yahoo.com/v1/test/getcrumb", timeout=12
        ) as r:
            t = r.read().decode("utf-8", "replace").strip()
        if t and len(t) <= 20 and not re.search(r"[<>]|error", t, re.I):
            _CRUMB = t
    except Exception:
        pass
    return _CRUMB


def _raw(x):
    if isinstance(x, dict):
        return x.get("raw")
    if isinstance(x, (int, float)):
        return x
    return None


_earn_fail = 0
EARN_GIVEUP = 10  # 連続失敗がこの数に達したら以降の決算取得を諦める（価格の処理を止めないため）


def fetch_earnings(ysym):
    """次回決算日・通期/次四半期のアナリスト平均を取得。取れなければ None。

    Yahoo が 429 で塞がっているときに全銘柄で粘ると価格側の処理が進まないので、
    連続失敗が EARN_GIVEUP に達したら以降はスキップする。
    """
    global _earn_fail
    if _earn_fail >= EARN_GIVEUP:
        return None
    crumb = ensure_crumb()
    if not crumb:
        _earn_fail += 1
        return None
    mods = "calendarEvents,earningsTrend,defaultKeyStatistics"
    url = (
        f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{urllib.parse.quote(ysym)}"
        f"?modules={mods}&crumb={urllib.parse.quote(crumb)}"
    )
    try:
        with _opener().open(url, timeout=15) as r:
            j = json.load(r)
    except Exception:
        _earn_fail += 1
        return None
    res = ((j.get("quoteSummary") or {}).get("result")) or []
    if not res:
        _earn_fail += 1
        return None
    _earn_fail = 0
    R = res[0]
    out = {"next_date": None, "fy": None, "next_q": None}
    ce = (((R.get("calendarEvents") or {}).get("earnings") or {}).get("earningsDate")) or []
    ts = [_raw(x) for x in ce if _raw(x)]
    if ts:
        out["next_date"] = datetime.fromtimestamp(ts[0], tz=timezone.utc).strftime("%Y-%m-%d")
        if len(ts) > 1 and ts[1] != ts[0]:
            out["next_date_end"] = datetime.fromtimestamp(ts[1], tz=timezone.utc).strftime(
                "%Y-%m-%d"
            )
    by = {t.get("period"): t for t in ((R.get("earningsTrend") or {}).get("trend") or []) if t}
    for key, label in (("0y", "fy"), ("+1q", "next_q"), ("0q", "next_q")):
        t = by.get(key)
        if not t or out.get(label):
            continue
        ee, re_ = t.get("earningsEstimate") or {}, t.get("revenueEstimate") or {}
        out[label] = {
            "period": key,
            "eps": _raw(ee.get("avg")),
            "revenue": _raw(re_.get("avg")),
            "analysts": _raw(ee.get("numberOfAnalysts")),
        }
    return out if (out["next_date"] or out["fy"] or out["next_q"]) else None


_q_fail = 0


def fetch_quarters(ysym, n=8):
    """四半期の売上・EPS（crumb 不要のエンドポイント）。連続失敗が続けば諦める。"""
    global _q_fail
    if _q_fail >= EARN_GIVEUP:
        return None
    p2 = int(time.time())
    p1 = p2 - 5 * 365 * 86400
    types = "quarterlyTotalRevenue,quarterlyDilutedEPS,quarterlyBasicEPS"
    url = (
        "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/"
        f"{urllib.parse.quote(ysym)}?symbol={urllib.parse.quote(ysym)}&type={types}"
        f"&period1={p1}&period2={p2}"
    )
    j, _ = _get_json(url)
    if j is None:
        _q_fail += 1
        return None
    _q_fail = 0
    by = {}
    for block in (j.get("timeseries") or {}).get("result") or []:
        key = ((block.get("meta") or {}).get("type") or [None])[0]
        if not key or not isinstance(block.get(key), list):
            continue
        for row in block[key]:
            if not row or not row.get("asOfDate"):
                continue
            d = row["asOfDate"]
            rec = by.setdefault(d, {"date": d, "rev": None, "eps": None})
            v = _raw(row.get("reportedValue"))
            if v is None:
                continue
            if key == "quarterlyTotalRevenue":
                rec["rev"] = v
            elif key == "quarterlyDilutedEPS":
                rec["eps"] = v
            elif key == "quarterlyBasicEPS" and rec["eps"] is None:
                rec["eps"] = v
    rows = sorted(by.values(), key=lambda r: r["date"])
    return rows[-n:] if rows else None


# --------------------------------------------------------------------- 因子
def sma(vals, n):
    return sum(vals[-n:]) / n if len(vals) >= n else None


def daily_vol(vals, n=60):
    if len(vals) < n + 1:
        return None
    rets = [vals[i] / vals[i - 1] - 1 for i in range(len(vals) - n, len(vals))]
    mu = sum(rets) / len(rets)
    var = sum((r - mu) ** 2 for r in rets) / max(1, len(rets) - 1)
    return math.sqrt(var)


def range_pos(vals):
    """52週(直近252営業日)レンジ内の位置 0..1。高値圏ほど 1 に近い。"""
    w = vals[-252:] if len(vals) >= 252 else vals
    lo, hi = min(w), max(w)
    if hi <= lo:
        return 0.5
    return (vals[-1] - lo) / (hi - lo)


def normalize_scale(vals):
    """株式分割・Yahooの混合スケール(例: 2559が281/2968/28100の3桁混在)を正規化する。
    上下どちらの段差も「古い側を新しい側の桁に合わせる」。index.htmlのsplitAdjustと同一ロジック。"""
    import math as _m
    if len(vals) < 3:
        return vals
    def med(a):
        s = sorted(a)
        return s[len(s) // 2]
    # 桁スナップ(前段): 隣接点との比がほぼ10^kの点だけ10^kで割り最終スケールへ揃える。
    # Yahooの東証データは分割前後で×10スケールと÷10異常ティックが同一系列に混在するため
    # 段差検出より先にこれで桁を統一する(10:1分割もここで揃う)。
    def snap(v, ref):
        l = _m.log10(v / ref)
        k = round(l)
        return v / (10 ** k) if (k != 0 and abs(l - k) < _m.log10(1.6)) else v
    anchor = med(vals[-7:])
    snapped = [0.0] * len(vals)
    snapped[-1] = snap(vals[-1], anchor)
    for i in range(len(vals) - 2, -1, -1):
        snapped[i] = snap(vals[i], snapped[i + 1])
    vals = snapped
    adj = list(vals)
    f = 1.0
    for i in range(len(vals) - 1, 0, -1):
        adj[i] = vals[i] * f
        r = vals[i - 1] / vals[i]
        up = r < 1
        ratio = (1 / r) if up else r
        if ratio > 1.8:
            best, bd = 0, float("inf")
            for n in range(2, 31):
                d = abs(_m.log(ratio / n))
                if d < bd:
                    bd, best = d, n
            if bd < 0.1:
                before = med(vals[max(0, i - 3):i])
                after = med(vals[i:min(len(vals), i + 3)])
                r2 = (after / before) if up else (before / after)
                if r2 > 0 and abs(_m.log(r2 / best)) < 0.15:
                    f = f * best if up else f / best
    adj[0] = vals[0] * f
    return adj


def calc_factors(pts):
    vals = normalize_scale([c for _, c in pts])
    if len(vals) < 210:
        return None
    ret63 = vals[-1] / vals[-64] - 1 if len(vals) > 64 else 0.0
    ret126 = vals[-1] / vals[-127] - 1 if len(vals) > 127 else 0.0
    s50, s200 = sma(vals, 50), sma(vals, 200)
    trend = 0.0
    if s50 is not None and vals[-1] > s50:
        trend += 0.5
    if s50 is not None and s200 is not None and s50 > s200:
        trend += 0.5
    pos = range_pos(vals)
    vol = daily_vol(vals, 60) or 0.0
    return {
        "mom": 0.5 * ret63 + 0.5 * ret126,
        "trend": trend,
        "value": 1.0 - pos,
        "lowvol": -vol,
        "pos": pos,
        "vol": vol,
        "sma50": s50,
        "sma200": s200,
        "close": vals[-1],
        "above50": bool(s50 is not None and vals[-1] > s50),
        "golden": bool(s50 is not None and s200 is not None and s50 > s200),
    }


def dip_days(pts, max_n=8):
    """『50日線の上 かつ pos が直近ピーク比で0.10以上低下した後に反発した日』を抽出。"""
    vals = [c for _, c in pts]
    out = []
    if len(vals) < 260:
        return out
    for i in range(255, len(vals) - 1):
        win = vals[max(0, i - 251) : i + 1]
        lo, hi = min(win), max(win)
        if hi <= lo:
            continue
        pos = (vals[i] - lo) / (hi - lo)
        s50 = sum(vals[i - 49 : i + 1]) / 50
        if vals[i] <= s50:
            continue
        # 直近40日のpos最大（ピーク）と比較して0.10以上の低下
        peak = 0.0
        for j in range(max(255, i - 40), i):
            w2 = vals[max(0, j - 251) : j + 1]
            l2, h2 = min(w2), max(w2)
            if h2 > l2:
                peak = max(peak, (vals[j] - l2) / (h2 - l2))
        if peak - pos < 0.10:
            continue
        if vals[i + 1] <= vals[i]:  # 翌日に反発していること
            continue
        d = datetime.fromtimestamp(pts[i][0], tz=timezone.utc).strftime("%Y-%m-%d")
        if out and out[-1]["date"] >= d:
            continue
        # 同一の押し目局面が連続採用されないよう10営業日空ける
        if out and (i - out[-1]["_i"]) < 10:
            continue
        out.append({"date": d, "price": round(vals[i], 2), "pos": round(pos, 3), "_i": i})
    for o in out:
        o.pop("_i", None)
    return out[-max_n:]


def zscores(xs):
    n = len(xs)
    if n == 0:
        return []
    mu = sum(xs) / n
    var = sum((x - mu) ** 2 for x in xs) / max(1, n - 1)
    sd = math.sqrt(var)
    if sd <= 1e-12:
        return [0.0] * n
    return [(x - mu) / sd for x in xs]


# ETF・指数・投信っぽい名前（「注目の"個別株"」から外すための判定）
_ETF_RE = re.compile(
    r"(ETF|ETN|ETC\b|上場投信|上場インデックス|インデックスファンド|"
    r"iShares|iシェアーズ|Vanguard|バンガード|SPDR|Invesco|インベスコ|ProShares|"
    r"Direxion|Global X|グローバルX|MAXIS|eMAXIS|NEXT ?FUNDS|ネクストファンズ|"
    r"上場|連動型|Trust\b|Index Fund|Select Sector|野村インデックス)",
    re.I,
)


def is_etf(name, sector, symbol):
    if (sector or "").strip() in ("ETF", "投信", "指数"):
        return True
    return bool(_ETF_RE.search(name or ""))


def heat_label(heat):
    if heat > 85:
        return "過熱"
    if heat < 30:
        return "冷え込み"
    return "平常"


def trend_state(f):
    if f["above50"] and f["golden"]:
        return "上昇トレンド（50日線の上・50日線>200日線）"
    if f["above50"]:
        return "短期は上向き（50日線の上・長期は未転換）"
    if f["golden"]:
        return "長期は上向きだが短期は50日線割れ"
    return "下降トレンド（50日線・200日線とも下）"


# ------------------------------------------------------------------ 組み立て
def assemble(rows):
    """rows: [{name, symbol, sector, f(factors), dips}] → stocks dict"""
    if not rows:
        return {}
    z = {
        k: zscores([r["f"][k] for r in rows])
        for k in ("mom", "value", "lowvol")
    }
    for i, r in enumerate(rows):
        f = r["f"]
        r["z"] = {
            "mom": round(z["mom"][i], 3),
            "trend": round(f["trend"] * 2 - 1, 3),
            "value": round(z["value"][i], 3),
            "lowvol": round(z["lowvol"][i], 3),
        }
        r["score"] = (
            WEIGHTS["mom"] * z["mom"][i]
            + WEIGHTS["trend"] * (f["trend"] * 2 - 1)
            + WEIGHTS["value"] * z["value"][i]
            + WEIGHTS["lowvol"] * z["lowvol"][i]
        )
    rows.sort(key=lambda r: r["score"], reverse=True)

    # 選抜(in_top12)は選抜層の中だけで行う。rank は全体順位、sel_rank は選抜層内順位。
    sel_rank = 0
    for r in rows:
        if r.get("selection_universe", True):
            sel_rank += 1
            r["_sel_rank"] = sel_rank
        else:
            r["_sel_rank"] = None

    stocks = {}
    for rank, r in enumerate(rows, 1):
        f = r["f"]
        heat = int(round(f["pos"] * 100))
        sel = r.get("selection_universe", True)
        stocks[r["symbol"]] = {
            "name": r["name"],
            "sector": r.get("sector", ""),
            "score": round(r["score"], 4),
            "rank": rank,
            "selection_universe": sel,
            "is_etf": is_etf(r["name"], r.get("sector"), r["symbol"]),
            "selection_rank": r["_sel_rank"],
            "in_top12": bool(sel and r["_sel_rank"] is not None and r["_sel_rank"] <= TOPN),
            "z": r["z"],
            "trend_state": trend_state(f),
            "above_sma50": f["above50"],
            "sma50_over_sma200": f["golden"],
            "pos": round(f["pos"], 4),
            "heat": heat,
            "heat_label": heat_label(heat),
            "vol60": round(f["vol"], 5),
            "close": round(f["close"], 2),
            "currency": "JPY" if r["symbol"].startswith("TSE:") else "USD",
            "dip_days": r.get("dips", []),
            "earnings": r.get("earnings"),
            "quarters": r.get("quarters"),
            # 価格の出どころ: "cache"=ローカル日足キャッシュ / "live"=Yahoo直取得
            "source": r.get("source", "sample"),
            "as_of": r.get("as_of"),
            "comment": None,  # Claude セッションが後から書き込む（API 未使用）
            # AIの見立て。生成スクリプトは常に None（API を呼ばない）。
            # 後から Claude セッションが {stance, reason, risk, written_at} を書き込む。
            # stance は "買い候補" / "様子見" / "判断保留" の3値のみ（ノーセルなので売りは無い）。
            "ai": None,
        }
    return stocks


AI_KEYS = ("stance", "reason", "risk", "written_at")
AI_STANCES = ("買い候補", "様子見", "判断保留")


def _clean_ai(v):
    """ai 欄として妥当なものだけ通す。stance が未知の値なら「判断保留」に倒す。"""
    if not isinstance(v, dict):
        return None
    out = {k: v[k] for k in AI_KEYS if v.get(k)}
    if not out.get("reason") and not out.get("risk"):
        return None
    out["stance"] = out.get("stance") if out.get("stance") in AI_STANCES else "判断保留"
    # 生成元の記録用フィールドは受け取ったまま残す（author / basis 等）
    for k in ("author", "basis"):
        if v.get(k):
            out[k] = v[k]
    return out


def load_existing_annotations(path):
    """既存 analysis_v21ns.json から手書き部分（comment / ai）を回収する。

    毎朝 cron で再生成するため、これを引き継がないと Claude セッションが
    書き込んだ AI の見立てが毎日消える（2026-08 のバグ修正）。
    """
    try:
        with open(path, encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    for k, v in (old.get("stocks") or {}).items():
        if not isinstance(v, dict):
            continue
        keep = {}
        if v.get("comment"):
            keep["comment"] = v["comment"]
        ai = _clean_ai(v.get("ai"))
        if ai:
            keep["ai"] = ai
        if keep:
            out[k] = keep
    return out


def load_ai_file(path):
    """外部ファイル ai_comments.json から ai 欄を読む。

    形式: {"NASDAQ:AAPL": {"stance":..,"reason":..,"risk":..,"written_at":..}, ...}
    Claude セッション（サブスク範囲）がここに書き込む運用。課金 API は使わない。
    優先順位は「このファイルにあればそれ / 無ければ既存 JSON の ai を保持」。
    """
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        print(f"警告: {path} を読めません（無視します）: {e}", file=sys.stderr)
        return {}
    if isinstance(raw, dict) and isinstance(raw.get("stocks"), dict):
        raw = raw["stocks"]  # analysis_v21ns.json 形式で渡された場合も受ける
    if not isinstance(raw, dict):
        return {}
    out = {}
    for sym, v in raw.items():
        ai = _clean_ai(v.get("ai") if isinstance(v, dict) and "ai" in v else v)
        if ai:
            out[sym] = ai
    return out


# --------------------------------------------------------------------- sample
SAMPLE = [
    ("TSE:2559", "オルカン（連動ETF: MAXIS全世界株式）", "ETF", 24800.0, 0.0072),
    ("TSE:1655", "iシェアーズ S&P500 円建てETF", "ETF", 6120.0, 0.0091),
    ("NASDAQ:QQQ", "インベスコ QQQ（NASDAQ100）", "ETF", 638.0, 0.0113),
    ("TSE:1321", "野村 日経225連動型上場投信", "ETF", 69200.0, 0.0104),
    ("TSE:7974", "任天堂", "Consumer Cyclical", 14350.0, 0.0186),
    ("NASDAQ:AAPL", "アップル", "テック", 271.0, 0.0142),
]


def make_sample_series(seed, last, vol, n=520):
    """実データと同じ形の擬似日足を生成（--sample 用・ネット不要）。"""
    rnd = random.Random(seed)
    vals = [last]
    for _ in range(n - 1):
        vals.append(vals[-1] / (1 + rnd.gauss(0.0004, vol)))
    vals.reverse()
    base = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    pts = []
    d = base - timedelta(days=int(n * 1.45))
    i = 0
    while len(pts) < n:
        if d.weekday() < 5:
            pts.append((int(d.timestamp()), round(vals[i], 3)))
            i += 1
        d += timedelta(days=1)
    return pts


def sample_earnings(idx, sym, last):
    """--sample 用のダミー決算（実データと同じ形）。ETF/指数は決算を持たない。"""
    if sym in ("TSE:2559", "TSE:1655", "TSE:1321", "NASDAQ:QQQ"):
        return None, None
    rnd = random.Random(7000 + idx)
    d = (datetime.now(timezone.utc) + timedelta(days=rnd.randint(8, 70))).strftime("%Y-%m-%d")
    jp = sym.startswith("TSE:")
    scale = 2.4e12 if jp else 4.1e11
    eps0 = last / rnd.uniform(14, 28)
    earn = {
        "next_date": d,
        "fy": {"period": "0y", "eps": round(eps0 * 4, 2), "revenue": round(scale), "analysts": rnd.randint(9, 26)},
        "next_q": {"period": "+1q", "eps": round(eps0, 2), "revenue": round(scale / 4), "analysts": rnd.randint(8, 24)},
    }
    quarters, base = [], datetime.now(timezone.utc)
    for k in range(8, 0, -1):
        qd = (base - timedelta(days=k * 91)).strftime("%Y-%m-%d")
        g = 1 + 0.06 * (8 - k) + rnd.uniform(-0.05, 0.05)
        quarters.append(
            {"date": qd, "rev": round(scale / 4 * g), "eps": round(eps0 * g, 2)}
        )
    return earn, quarters


def build_sample():
    rows = []
    for idx, (sym, name, sector, last, vol) in enumerate(SAMPLE):
        pts = make_sample_series(1000 + idx, last, vol)
        f = calc_factors(pts)
        if not f:
            continue
        earn, quarters = sample_earnings(idx, sym, last)
        rows.append(
            {
                "name": name,
                "symbol": sym,
                "sector": sector,
                # 2層ユニバースのプレビュー用: QQQ / 1321 は「分析のみ（選抜対象外）」扱い
                "selection_universe": sym not in ("NASDAQ:QQQ", "TSE:1321"),
                "source": "sample",
                "f": f,
                "dips": dip_days(pts),
                "earnings": earn,
                "quarters": quarters,
            }
        )
    return rows


# ----------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="analysis_v21ns.json を生成する")
    ap.add_argument("--sample", action="store_true", help="ネット不要のダミーデータで生成")
    ap.add_argument("--out", default=OUT_DEFAULT, help="出力先 JSON パス")
    ap.add_argument("--limit", type=int, default=None, help="ユニバース件数の上限")
    ap.add_argument(
        "--big",
        default=None,
        help="universe_big.json のパス（リポジトリ外。分析専用の追加ユニバース）",
    )
    ap.add_argument(
        "--big-limit",
        type=int,
        default=None,
        help="big 側から採用する先頭N件（既定=全件。日本株＋米国株＋ETF全部）",
    )
    ap.add_argument(
        "--prices",
        default=None,
        help="ローカル日足キャッシュ {sym: [[date, close],...]} のパス（一次ソース。repo外・読むだけ）",
    )
    ap.add_argument(
        "--cache-only",
        action="store_true",
        help="キャッシュに無い銘柄を Yahoo に取りに行かない（429を完全回避）",
    )
    ap.add_argument("--sleep", type=float, default=0.6, help="API 呼び出し間隔(秒)")
    ap.add_argument(
        "--merge-comments",
        action="store_true",
        default=True,
        help="既存 JSON の comment と ai（AIの見立て）を引き継ぐ（既定で有効）",
    )
    ap.add_argument(
        "--no-merge-comments",
        dest="merge_comments",
        action="store_false",
        help="既存 JSON の手書き部分を引き継がない（毎朝の再生成では使わないこと）",
    )
    ap.add_argument(
        "--ai-file",
        default="ai_comments.json",
        help="AIの見立てを読む外部ファイル（{SYMBOL:{stance,reason,risk,written_at}}）。"
        "無ければ既存 JSON の ai をそのまま保持する。課金 API は一切使わない。",
    )
    args = ap.parse_args()

    if args.sample:
        rows = build_sample()
        note = "sample"
        stats = {"cache": 0, "live": 0, "no_price": 0}
    else:
        uni = build_universe(args.limit, args.big, args.big_limit)
        total = len(uni)
        rows, skips = [], 0
        t0 = time.time()
        load_price_cache(args.prices)
        consec_fail = 0
        n_cache = n_live = no_price = 0
        for i, it in enumerate(uni, 1):
            ysym = to_yahoo(it["symbol"])
            # ① ローカルキャッシュ優先（Yahooを叩かない＝429を踏まない）
            pts, src = cache_series(ysym), "cache"
            if not pts:
                # ② キャッシュに無い銘柄だけ Yahoo にフォールバック
                if args.cache_only:
                    no_price += 1
                    skips += 1
                    time.sleep(0)
                    continue
                pts, src = fetch_chart(ysym), "live"
            if not pts:
                skips += 1
                no_price += 1
                consec_fail += 1
                print(f"  skip {it['symbol']} ({ysym})", file=sys.stderr, flush=True)
                # 連続失敗が続く＝Yahoo側にIPごと弾かれている。銘柄ごとに60秒ずつ
                # 溶かしても無駄なので、まとめて長めに冷ましてから再開する。
                if consec_fail % 8 == 0:
                    cool = min(900, 300 * (consec_fail // 8))
                    print(
                        f"  ！連続{consec_fail}件失敗 → {cool}秒クールダウン",
                        file=sys.stderr,
                        flush=True,
                    )
                    time.sleep(cool)
                time.sleep(args.sleep)
                continue
            consec_fail = 0
            f = calc_factors(pts)
            if f:
                if src == "cache":
                    n_cache += 1
                else:
                    n_live += 1
                # 決算は選抜層だけ取得（全銘柄だと crumb API を叩きすぎるため）
                sel = it.get("selection_universe", True)
                rows.append(
                    {
                        **it,
                        "f": f,
                        "dips": dip_days(pts),
                        "source": src,
                        "as_of": cache_as_of(ysym) if src == "cache" else None,
                        "earnings": fetch_earnings(ysym) if sel else None,
                        "quarters": fetch_quarters(ysym) if sel else None,
                    }
                )
            else:
                skips += 1
                no_price += 1
            if i % 20 == 0:
                el = time.time() - t0
                eta = (el / i) * (total - i) / 60
                print(
                    f"{i}/{total} done, skips={skips} "
                    f"(cache{n_cache}/live{n_live} / rate-limit{_rate_hits}回 / 残り約{eta:.0f}分)",
                    file=sys.stderr,
                    flush=True,
                )
            # キャッシュヒット時は外部アクセスしていないので待つ必要がない
            if src == "live":
                time.sleep(args.sleep)
        print(
            f"{total}/{total} done, skips={skips} (cache{n_cache}/live{n_live}/価格なし{no_price})",
            file=sys.stderr,
            flush=True,
        )
        note = "cache+live" if n_live else "cache"
        stats = {"cache": n_cache, "live": n_live, "no_price": no_price}

    stocks = assemble(rows)

    # 手書き部分（comment / ai）の引き継ぎ。
    # 優先順位: ai_comments.json ＞ 既存 analysis_v21ns.json の ai。
    # どちらも Claude セッション（サブスク範囲）が書くもので、課金 API は関与しない。
    n_ai_kept = n_ai_file = 0
    if args.merge_comments:
        for sym, keep in load_existing_annotations(args.out).items():
            if sym not in stocks:
                continue
            if keep.get("comment"):
                stocks[sym]["comment"] = keep["comment"]
            if keep.get("ai"):
                stocks[sym]["ai"] = keep["ai"]
                n_ai_kept += 1
    for sym, ai in load_ai_file(args.ai_file).items():
        if sym in stocks:
            if not stocks[sym].get("ai"):
                n_ai_kept += 1
            stocks[sym]["ai"] = ai
            n_ai_file += 1
    n_ai = sum(1 for v in stocks.values() if v.get("ai"))
    print(
        f"AIの見立て: {n_ai}銘柄（既存JSONから継承{n_ai_kept - n_ai_file} / "
        f"{args.ai_file}から{n_ai_file}）",
        file=sys.stderr,
        flush=True,
    )

    n_sel = sum(1 for v in stocks.values() if v["selection_universe"])
    as_ofs = sorted(v["as_of"] for v in stocks.values() if v.get("as_of"))
    out = {
        "updated": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": note,
        # 因子スコアが計算された価格の基準日（キャッシュ由来の最終営業日）。
        # フロントの「現値」は Yahoo からリアルタイムに取るのでこの日付とはズレる。
        "as_of": as_ofs[-1] if as_ofs else None,
        "as_of_min": as_ofs[0] if as_ofs else None,
        "universe_n": len(stocks),
        "covered": len(stocks),
        "skipped_no_price": stats["no_price"],
        "from_cache": stats["cache"],
        "from_live": stats["live"],
        "selection_universe_n": n_sel,
        "analysis_only_n": len(stocks) - n_sel,
        "weights": WEIGHTS,
        "topn": TOPN,
        "note": (
            "V2.1-NS（ノーセル）の価格4因子スコア。売り推奨は存在せず、保有は常に継続。"
            "スコア・rank は全銘柄横断で計算するが、top12 の選抜は selection_universe=true "
            "の層（update_analysis.mjs の固定リスト＋保有＋初期リスト）の中だけで行う。"
            "comment は Claude セッションが後から追記する。投資助言ではない。"
        ),
        # AIの見立ての出どころ。課金 API は一切使わない（サブスク範囲の Claude セッションが書く）。
        "ai_written": {
            "count": n_ai,
            "method": "claude-session",
            "api_used": False,
            "written_at": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d"),
            "note": (
                "AI欄は Claude セッションが analysis_v21ns.json の実測因子のみを見て記述。"
                "課金APIは未使用。企業のファンダメンタル予想は含まない。"
            ),
        },
        "stocks": stocks,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")
    top = [s for s, v in stocks.items() if v["in_top12"]]
    print(
        f"wrote {args.out}: {len(stocks)} 銘柄"
        f"（選抜層{n_sel} / 分析のみ{len(stocks) - n_sel}） / top12={top}",
        file=sys.stderr,
        flush=True,
    )


if __name__ == "__main__":
    main()
