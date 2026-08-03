# -*- coding: utf-8 -*-
"""指定銘柄の「見立てを書くための事実」を1件だけ集めて出力する。

用途: ユーザーがデスク画面で見ている銘柄について、その場でClaudeが見立てを書く。
908銘柄を一括取得すると429で落ちるが、**1銘柄なら決算も確実に取れる**。
課金APIは使わない(書くのはClaudeセッション自身)。

    python3 scripts/fact_packet.py NASDAQ:MU
"""
import json, os, sys, urllib.parse, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def yahoo_symbol(sym):
    ex, _, t = sym.partition(":")
    return t + ".T" if ex == "TSE" else t


def get_json(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except Exception as e:            # 取れなければ None。**推測で埋めない**
        print(f"  (取得失敗: {e})", file=sys.stderr)
        return None


def earnings_for(ysym):
    """1銘柄分の四半期業績。fundamentals-timeseries は crumb 不要で通ることが多い。"""
    base = ("https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/"
            f"{urllib.parse.quote(ysym)}?symbol={urllib.parse.quote(ysym)}"
            "&type=quarterlyTotalRevenue,quarterlyDilutedEPS&period1=1500000000&period2=9999999999")
    j = get_json(base)
    if not j:
        return []
    rows = {}
    for blk in (j.get("timeseries", {}) or {}).get("result", []) or []:
        for key in ("quarterlyTotalRevenue", "quarterlyDilutedEPS"):
            for it in blk.get(key, []) or []:
                if not it:
                    continue
                d = it.get("asOfDate")
                v = (it.get("reportedValue") or {}).get("raw")
                if d and v is not None:
                    rows.setdefault(d, {})["rev" if "Revenue" in key else "eps"] = v
    return [{"date": d, **rows[d]} for d in sorted(rows)][-8:]


def main():
    if len(sys.argv) < 2:
        print("usage: fact_packet.py <SYMBOL>  例: NASDAQ:MU", file=sys.stderr)
        sys.exit(1)
    sym = sys.argv[1].upper()
    an = json.load(open(os.path.join(BASE, "analysis_v21ns.json"), encoding="utf-8"))
    v = an["stocks"].get(sym)
    if not v:
        print(json.dumps({"symbol": sym, "error": "analysis_v21ns.json に無い銘柄"},
                         ensure_ascii=False, indent=1))
        return
    q = v.get("quarters") or []
    if not q:                          # JSONに無ければ、この1銘柄だけ取りに行く
        q = earnings_for(yahoo_symbol(sym))
    out = {k: v.get(k) for k in
           ("name", "sector", "score", "rank", "selection_universe", "selection_rank",
            "in_top12", "is_etf", "z", "trend_state", "pos", "heat", "heat_label",
            "vol60", "close", "currency")}
    out.update({"symbol": sym, "as_of": an.get("as_of"),
                "dip_days": [{"date": x["date"], "price": x["price"]} for x in (v.get("dip_days") or [])][:4],
                "quarters": q,
                "quarters_source": "json" if (v.get("quarters")) else ("live" if q else "none")})
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
