import math
import time
import threading
from datetime import datetime

import numpy as np
import pandas as pd
import yfinance as yf
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

scan_cache = {"JP": None, "US": None}
scan_progress = {"status": "idle", "current": 0, "total": 0, "message": ""}

WATCHLIST = {
    "JP": {
        "name": "日本株",
        "stocks": [
            "7203.T", "6758.T", "9984.T", "6861.T", "8035.T",
            "6501.T", "7741.T", "4063.T", "6902.T", "9983.T",
            "6098.T", "4519.T", "6594.T", "3659.T", "2413.T",
            "4661.T", "6367.T", "7974.T", "8306.T", "8316.T",
            "6326.T", "6723.T", "4543.T", "6981.T", "9433.T",
            "4568.T", "6857.T", "3407.T", "7267.T", "6762.T",
            "2802.T", "4452.T", "6503.T", "7751.T", "9434.T",
            "2914.T", "3382.T", "8001.T", "8058.T", "8031.T",
        ],
    },
    "US": {
        "name": "米国株",
        "stocks": [
            "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA",
            "META", "TSLA", "AMD", "CRM", "AVGO",
            "ORCL", "ADBE", "NFLX", "INTC", "QCOM",
            "UBER", "XYZ", "SHOP", "PLTR", "SNOW",
            "SOFI", "RKLB", "IONQ", "SMCI", "ARM",
            "COIN", "MARA", "RIOT", "NET", "DDOG",
            "CRWD", "ZS", "MDB", "ENPH", "FSLR",
            "LI", "NIO", "RIVN", "PLUG", "SEDG",
        ],
    },
}

SECTOR_THEMES = {
    "AI・半導体": {
        "keywords": ["AI", "半導体", "GPU", "データセンター"],
        "tickers": ["NVDA", "AMD", "AVGO", "ARM", "INTC", "SMCI", "PLTR", "IONQ",
                     "8035.T", "6857.T", "6723.T"],
        "outlook": "生成AI需要の爆発的成長により、半導体・AI関連は中長期的に高成長が見込まれる",
    },
    "EV・クリーンエネルギー": {
        "keywords": ["EV", "電気自動車", "太陽光", "再生可能エネルギー"],
        "tickers": ["TSLA", "RIVN", "NIO", "LI", "ENPH", "FSLR", "PLUG", "SEDG",
                     "7203.T"],
        "outlook": "各国の脱炭素政策により長期的な成長トレンド。短期的には金利動向に注意",
    },
    "フィンテック・暗号資産": {
        "keywords": ["フィンテック", "暗号資産", "ブロックチェーン", "決済"],
        "tickers": ["XYZ", "COIN", "SOFI", "MARA", "RIOT"],
        "outlook": "暗号資産市場の成熟化とデジタル決済の普及で中長期的に成長余地あり",
    },
    "サイバーセキュリティ": {
        "keywords": ["セキュリティ", "クラウド", "ゼロトラスト"],
        "tickers": ["CRWD", "ZS", "NET"],
        "outlook": "サイバー脅威の増大により、セキュリティ支出は景気に関わらず増加傾向",
    },
    "宇宙・防衛": {
        "keywords": ["宇宙", "ロケット", "防衛"],
        "tickers": ["RKLB"],
        "outlook": "商業宇宙産業の急成長と各国の防衛費増大が追い風",
    },
    "日本・総合商社": {
        "keywords": ["商社", "資源", "投資"],
        "tickers": ["8001.T", "8058.T", "8031.T"],
        "outlook": "バフェット効果と資源高で再評価。割安で高配当が魅力",
    },
}


def safe_val(val):
    if val is None:
        return None
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def compute_rsi(prices, period=14):
    delta = prices.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.rolling(window=period, min_periods=period).mean()
    avg_loss = loss.rolling(window=period, min_periods=period).mean()
    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    return rsi


def compute_macd(prices, fast=12, slow=26, signal=9):
    ema_fast = prices.ewm(span=fast, adjust=False).mean()
    ema_slow = prices.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def get_info_with_retry(ticker_symbol, max_retries=3):
    for attempt in range(max_retries):
        try:
            ticker = yf.Ticker(ticker_symbol)
            info = ticker.info
            if info and len(info) > 5:
                return info
        except Exception as e:
            print(f"  Retry {attempt + 1}/{max_retries} for {ticker_symbol} info: {e}")
        wait = 2 ** attempt + 1
        time.sleep(wait)
    return None


def batch_scan(market):
    global scan_progress
    stocks_list = WATCHLIST.get(market, WATCHLIST["JP"])["stocks"]
    total = len(stocks_list)

    scan_progress = {"status": "downloading", "current": 0, "total": total,
                     "message": "株価データを一括ダウンロード中..."}

    print(f"[Scan] Batch downloading price data for {total} tickers...")
    all_hist = yf.download(
        stocks_list,
        period="1y",
        group_by="ticker",
        threads=True,
        progress=False,
    )
    time.sleep(1)

    results = []
    for i, ticker_symbol in enumerate(stocks_list):
        scan_progress = {
            "status": "analyzing",
            "current": i + 1,
            "total": total,
            "message": f"{ticker_symbol} を分析中... ({i + 1}/{total})",
        }
        print(f"[Scan] Analyzing {ticker_symbol} ({i + 1}/{total})")

        try:
            if len(stocks_list) > 1:
                if ticker_symbol in all_hist.columns.get_level_values(0):
                    hist = all_hist[ticker_symbol].dropna(how="all")
                else:
                    print(f"  {ticker_symbol}: no price data in batch")
                    continue
            else:
                hist = all_hist.dropna(how="all")

            if hist.empty or len(hist) < 50:
                print(f"  {ticker_symbol}: insufficient price data ({len(hist)} rows)")
                continue

            close = hist["Close"].dropna()
            if len(close) < 50:
                continue
            current_price = float(close.iloc[-1])

            info = get_info_with_retry(ticker_symbol)
            if not info:
                print(f"  {ticker_symbol}: could not fetch info")
                continue

            time.sleep(1.5)

            rsi = compute_rsi(close)
            rsi_vals = rsi.dropna()
            current_rsi = safe_val(float(rsi_vals.iloc[-1])) if len(rsi_vals) > 0 else None

            macd_line, signal_line, macd_hist = compute_macd(close)
            current_macd = safe_val(float(macd_line.iloc[-1]))
            current_signal = safe_val(float(signal_line.iloc[-1]))
            macd_cross = "bullish" if current_macd and current_signal and current_macd > current_signal else "bearish"

            sma_50_series = close.rolling(50).mean().dropna()
            sma_50 = float(sma_50_series.iloc[-1]) if len(sma_50_series) > 0 else None
            sma_200 = None
            if len(close) >= 200:
                sma_200_series = close.rolling(200).mean().dropna()
                sma_200 = float(sma_200_series.iloc[-1]) if len(sma_200_series) > 0 else None

            price_vs_sma50 = ((current_price - sma_50) / sma_50 * 100) if sma_50 else 0
            price_vs_sma200 = ((current_price - sma_200) / sma_200 * 100) if sma_200 else None

            pe = safe_val(info.get("trailingPE")) or safe_val(info.get("forwardPE"))
            pb = safe_val(info.get("priceToBook"))
            roe = safe_val(info.get("returnOnEquity"))
            if roe is not None:
                roe *= 100
            revenue_growth = safe_val(info.get("revenueGrowth"))
            if revenue_growth is not None:
                revenue_growth *= 100
            earnings_growth = safe_val(info.get("earningsGrowth"))
            if earnings_growth is not None:
                earnings_growth *= 100
            profit_margin = safe_val(info.get("profitMargins"))
            if profit_margin is not None:
                profit_margin *= 100
            dividend_yield = safe_val(info.get("dividendYield"))
            if dividend_yield is not None:
                dividend_yield *= 100
            market_cap = safe_val(info.get("marketCap"))
            forward_pe = safe_val(info.get("forwardPE"))
            peg = safe_val(info.get("pegRatio"))

            year_high = safe_val(info.get("fiftyTwoWeekHigh"))
            year_low = safe_val(info.get("fiftyTwoWeekLow"))
            from_high = ((current_price - year_high) / year_high * 100) if year_high else None
            from_low = ((current_price - year_low) / year_low * 100) if year_low else None

            value_score = 0
            growth_score = 0
            timing_score = 0

            if pe is not None and pe > 0:
                if pe < 10:
                    value_score += 30
                elif pe < 15:
                    value_score += 20
                elif pe < 20:
                    value_score += 10
            if pb is not None and pb > 0:
                if pb < 1.0:
                    value_score += 25
                elif pb < 1.5:
                    value_score += 15
                elif pb < 2.0:
                    value_score += 5
            if peg is not None and peg > 0:
                if peg < 1.0:
                    value_score += 20
                elif peg < 1.5:
                    value_score += 10
            if forward_pe and pe and forward_pe < pe:
                value_score += 10
            if dividend_yield is not None and dividend_yield > 3:
                value_score += 10

            if roe is not None and roe > 15:
                growth_score += 20
            elif roe is not None and roe > 10:
                growth_score += 10
            if revenue_growth is not None and revenue_growth > 20:
                growth_score += 25
            elif revenue_growth is not None and revenue_growth > 10:
                growth_score += 15
            if earnings_growth is not None and earnings_growth > 20:
                growth_score += 25
            elif earnings_growth is not None and earnings_growth > 10:
                growth_score += 15
            if profit_margin is not None and profit_margin > 20:
                growth_score += 15
            elif profit_margin is not None and profit_margin > 10:
                growth_score += 10

            if current_rsi is not None:
                if current_rsi < 30:
                    timing_score += 30
                elif current_rsi < 40:
                    timing_score += 20
                elif current_rsi < 50:
                    timing_score += 10
            if price_vs_sma50 < -5:
                timing_score += 15
            elif price_vs_sma50 < 0:
                timing_score += 10
            if price_vs_sma200 is not None and price_vs_sma200 < -10:
                timing_score += 15
            elif price_vs_sma200 is not None and price_vs_sma200 < 0:
                timing_score += 10
            if macd_cross == "bullish":
                timing_score += 15
            if from_high is not None and from_high < -20:
                timing_score += 15
            elif from_high is not None and from_high < -10:
                timing_score += 10

            total_score = value_score + growth_score + timing_score

            if timing_score >= 50:
                timing_signal = "強い買いシグナル"
                timing_color = "strong-buy"
            elif timing_score >= 30:
                timing_signal = "買いシグナル"
                timing_color = "buy"
            elif timing_score >= 15:
                timing_signal = "やや買い"
                timing_color = "moderate-buy"
            else:
                timing_signal = "様子見"
                timing_color = "wait"

            themes = []
            for theme_name, theme_data in SECTOR_THEMES.items():
                if ticker_symbol in theme_data["tickers"]:
                    themes.append({"name": theme_name, "outlook": theme_data["outlook"]})

            price_data = []
            for idx, row in hist.tail(90).iterrows():
                c = safe_val(row.get("Close"))
                v = row.get("Volume")
                if c is not None:
                    price_data.append({
                        "date": idx.strftime("%Y-%m-%d"),
                        "close": round(c, 2),
                        "volume": int(v) if v is not None and not math.isnan(v) else 0,
                    })

            result = {
                "ticker": ticker_symbol,
                "name": info.get("shortName") or info.get("longName") or ticker_symbol,
                "sector": info.get("sector", "N/A"),
                "industry": info.get("industry", "N/A"),
                "currency": info.get("currency", ""),
                "currentPrice": round(current_price, 2),
                "marketCap": market_cap,
                "pe": round(pe, 2) if pe else None,
                "forwardPE": round(forward_pe, 2) if forward_pe else None,
                "pb": round(pb, 2) if pb else None,
                "peg": round(peg, 2) if peg else None,
                "roe": round(roe, 2) if roe is not None else None,
                "revenueGrowth": round(revenue_growth, 2) if revenue_growth is not None else None,
                "earningsGrowth": round(earnings_growth, 2) if earnings_growth is not None else None,
                "profitMargin": round(profit_margin, 2) if profit_margin is not None else None,
                "dividendYield": round(dividend_yield, 2) if dividend_yield is not None else None,
                "rsi": round(current_rsi, 2) if current_rsi is not None else None,
                "macdCross": macd_cross,
                "sma50": round(sma_50, 2) if sma_50 else None,
                "sma200": round(sma_200, 2) if sma_200 else None,
                "priceVsSma50": round(price_vs_sma50, 2),
                "priceVsSma200": round(price_vs_sma200, 2) if price_vs_sma200 is not None else None,
                "yearHigh": round(year_high, 2) if year_high else None,
                "yearLow": round(year_low, 2) if year_low else None,
                "fromHigh": round(from_high, 2) if from_high is not None else None,
                "fromLow": round(from_low, 2) if from_low is not None else None,
                "valueScore": value_score,
                "growthScore": growth_score,
                "timingScore": timing_score,
                "totalScore": total_score,
                "timingSignal": timing_signal,
                "timingColor": timing_color,
                "themes": themes,
                "priceData": price_data,
            }
            results.append(result)
            print(f"  ✓ {ticker_symbol}: score={total_score}")

        except Exception as e:
            print(f"  ✗ {ticker_symbol}: {e}")
            continue

    results.sort(key=lambda x: x["totalScore"], reverse=True)

    scan_result = {"results": results, "scannedAt": datetime.now().isoformat()}
    scan_cache[market] = scan_result
    scan_progress = {"status": "done", "current": total, "total": total,
                     "message": f"完了: {len(results)}銘柄を分析"}
    print(f"[Scan] Complete: {len(results)} stocks analyzed")
    return scan_result


def run_scan_background(market):
    global scan_progress
    try:
        batch_scan(market)
    except Exception as e:
        scan_progress = {"status": "error", "current": 0, "total": 0, "message": str(e)}
        print(f"[Scan] Background scan failed: {e}")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/scan", methods=["POST"])
def scan_stocks():
    global scan_progress
    data = request.get_json() or {}
    market = data.get("market", "JP")

    if scan_progress.get("status") in ("downloading", "analyzing"):
        return jsonify({"error": "スキャン実行中です。完了までお待ちください。"}), 409

    scan_progress = {"status": "starting", "current": 0, "total": 0, "message": "スキャンを開始しています..."}
    thread = threading.Thread(target=run_scan_background, args=(market,), daemon=True)
    thread.start()

    return jsonify({"accepted": True}), 202


@app.route("/api/progress")
def get_progress():
    return jsonify(scan_progress)


@app.route("/api/results/<market>")
def get_results(market):
    cached = scan_cache.get(market)
    if cached:
        return jsonify(cached)
    return jsonify({"results": [], "scannedAt": None}), 404


@app.route("/api/themes")
def get_themes():
    themes = []
    for name, data in SECTOR_THEMES.items():
        themes.append({
            "name": name,
            "outlook": data["outlook"],
            "tickers": data["tickers"],
        })
    return jsonify(themes)


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5050))
    app.run(host="0.0.0.0", port=port, debug=True)
