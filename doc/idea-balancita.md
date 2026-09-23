# AGENT INSTRUCTION & ARCHITECTURE BLUEPRINT: BALANCITA (BTC-EUR TRADING SUITE)

## 1. Project Goal
Build a high-performance, low-latency, local-first cryptocurrency monitoring and paper-trading desktop web application named **Balancita**.
* **Target Asset:** BTC-EUR.
* **Interval:** 1-minute real-time candlesticks.
* **Core Philosophy:** Minimal latency, zero heavy UI frameworks (pure HTML5/Canvas/CSS Grid + Vanilla JS), asynchronous Python backend (FastAPI + WebSockets + Polars/NumPy).

---

## 2. Visual Layout Specification (Strict Adherence Required)
The UI must strictly reproduce this layout using CSS Grid:

```text
+-------------------------------------------------------------+------------------------+
| (O) Balancita (BTC/EUR)                                     | Dinero disponible:     |
|                                                             | [ 10.000,00 EUR ]      |
+-------------------------------------------------------------+------------------------+
|                                                             | NOTICIAS EN TIEMPO REAL|
|                  TRADINGVIEW LIGHTWEIGHT                    | - News Item 1  |
|                  CHARTS CANVAS CONTAINER                    | - News Item 2  |
|                  (1m Klines via Binance WS)                 | - News Item 3  |
|                                                             | - News Item 4  |
+-------------------------------------------------------------+------------------------+
| [ Comprar ]       [ Vender ]       [ Auto Trading (ON/OFF)] | Info General BTC-EUR   |
|                                                             | Vol 24h / High / Low   |
+-------------------------------------------------------------+------------------------+

3. Technology Stack & Dependencies
Backend
Runtime: Python 3.11+

Framework: fastapi, uvicorn[standard]

Network & Sockets: websockets, aiohttp

Data Processing: polars, numpy

Frontend
HTML5 Canvas: lightweight-charts (TradingView standalone library via unpkg CDN).

Styles: Native CSS Grid & Flexbox, dark theme (#181920 base, #26a69a green, #ef5350 red, #f7931a bitcoin orange).

JS: Native modern Vanilla JavaScript (no React/Vue/Node build step required).

4. Implementation Steps for OpenCode
Execute the following implementation steps in order:

Step 1: Project Setup & Dependencies
Generate requirements.txt:

Plaintext
fastapi>=0.110.0
uvicorn[standard]>=0.28.0
websockets>=12.0
aiohttp>=3.9.0
polars>=0.20.0
numpy>=1.26.0
requests>=2.31.0
Step 2: Market Ingestion Worker (engine/market.py)
Create an async worker that connects to Binance's public WebSocket:
wss://stream.binance.com:9443/ws/btceur@kline_1m

Parse the incoming JSON:

Candle payload: payload["k"]

Format fields:

Python
{
    "time": k["t"] // 1000,  # UNIX timestamp in seconds
    "open": float(k["o"]),
    "high": float(k["h"]),
    "low": float(k["l"]),
    "close": float(k["c"]),
    "volume": float(k["v"]),
    "is_closed": bool(k["x"]),
}
Maintain an in-memory rolling ring buffer of the latest 300 completed 1m candles.

Broadcast every tick/update to an internal asyncio.Queue or connected client set.

Step 3: News Feed Service (engine/news.py)
Fetch latest Bitcoin headlines from CryptoPanic API (https://cryptopanic.com/api/v1/posts/?auth_token=PUBLIC&currencies=BTC) or fallback to Cointelegraph/CoinDesk public RSS feed via aiohttp.

Format news items:

JSON
[
  {"time": "11:32", "title": "Bitcoin tests key support level at 60k EUR", "source": "CoinDesk"},
  {"time": "11:20", "title": "ECB publishes report on digital assets", "source": "CryptoPanic"}
]
Cache news in memory and refresh every 120 seconds in a background task.

Step 4: Paper Trading & Auto-Trading Engine (engine/trader.py)
Paper Account State:

Initial Balance: 10000.00 EUR.

BTC Position: 0.00000000 BTC.

auto_trading_enabled: boolean (default False).

Execution Logic:

buy_market(amount_eur): Deducts EUR balance, adds BTC at current_price (apply 0.075% simulated fee).

sell_market(amount_btc): Deducts BTC balance, adds EUR at current_price (apply 0.075% simulated fee).

Auto-Trading Strategy (1m Strategy):

Use an EMA cross (Fast EMA 9, Slow EMA 21) or RSI (14 periods) computed over the 1m rolling buffer using numpy/polars.

When auto_trading_enabled is True and a candle closes (is_closed == True):

If Fast EMA crosses above Slow EMA and RSI < 65: trigger paper buy (allocate 20% of free EUR).

If Fast EMA crosses below Slow EMA and RSI > 35: trigger paper sell (liquidate current BTC).

Step 5: FastAPI Application & Endpoints (main.py)
Serve static/ directory.

GET /: Serves static/index.html.

GET /api/account: Returns { "balance_eur": float, "balance_btc": float, "auto_trading": bool }.

POST /api/trade/buy: Executes manual paper buy.

POST /api/trade/sell: Executes manual paper sell.

POST /api/trade/auto-toggle: Toggles auto_trading_enabled.

GET /api/news: Returns cached news list.

WebSocket /ws/stream:

Streams real-time 1m candle updates directly to the connected frontend.

Streams account balance updates when a trade executes.

Step 6: Frontend Interface (static/index.html, static/styles.css, static/app.js)
HTML: Implement semantic layout with CSS Grid matching the wireframe:

Top bar: Title + Logo on left, "Dinero disponible" with live EUR balance on right.

Middle grid: Chart container (left, 75% width), Real-time News list (right, 25% width).

Bottom grid: 3 Action buttons (Buy, Sell, Auto Trading toggle), General Info (BTC-EUR 24h Stats).

Lightweight Charts Integration:

Initialize LightweightCharts.createChart configured with dark palette.

Subscribe to /ws/stream WebSocket. On message:

Update candle series via series.update(candle).

Update latest price and 24h summary metrics.

Button Handlers:

Buy button: Calls POST /api/trade/buy.

Sell button: Calls POST /api/trade/sell.

Auto Trading button: Calls POST /api/trade/auto-toggle and switches label/color between "Auto Trading (ON)" (orange) and "Auto Trading (OFF)" (gray).

5. Verification & Acceptance Criteria
When all files are created:

Run pip install -r requirements.txt.

Start the server: uvicorn main:app --port 8000.

Verify that http://localhost:8000 loads immediately:

Chart renders and updates in real time with live Binance BTC-EUR 1m candles.

News feed loads and updates.

Buy/Sell buttons adjust the paper balance in real time without refreshing the page.

Auto-trading toggle persists state and evaluates trades on candle closes.