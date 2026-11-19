# Binance spot Kline API — checked 2026-11-19

Source: https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#klinecandlestick-data

Downloaded official REST document SHA256: f1500faf7ede9e1b24087e31e3d2517eb56db28f1d936fdfde845ce418ae3ca8

The complete Kline endpoint section used for this feature follows. It documents public GET, weight 2, 5m support, UTC default, limit maximum 1000 and the 12 response fields. No account credential is required.

### Kline/Candlestick data
```
GET /api/v3/klines
```
Kline/candlestick bars for a symbol.
Klines are uniquely identified by their open time.

**Weight:**
2

**Parameters:**

Name | Type | Mandatory | Description
------------ | ------------ | ------------ | ------------
symbol | STRING | YES |
interval | ENUM | YES |
startTime | LONG | NO |
endTime | LONG | NO |
timeZone | STRING | NO | Default: 0 (UTC)
limit | INT | NO | Default: 500; Maximum: 1000.

**Data Source:** Database

<a id="kline-intervals"></a>

Supported kline intervals (case-sensitive):

Interval  | `interval` value
--------- | ----------------
seconds   | `1s`
minutes   | `1m`, `3m`, `5m`, `15m`, `30m`
hours     | `1h`, `2h`, `4h`, `6h`, `8h`, `12h`
days      | `1d`, `3d`
weeks     | `1w`
months    | `1M`

**Notes:**

* If `startTime` and `endTime` are not sent, the most recent klines are returned.
* Supported values for `timeZone`:
  * Hours and minutes (e.g. `-1:00`, `05:45`)
  * Only hours (e.g. `0`, `8`, `4`)
  * Accepted range is strictly [-12:00 to +14:00] inclusive
* If `timeZone` provided, kline intervals are interpreted in that timezone instead of UTC.
* Note that `startTime` and `endTime` are always interpreted in UTC, regardless of `timeZone`.

**Response:**
```javascript
[
    [
        1499040000000,     // Open time
        "0.01634790",      // Open
        "0.80000000",      // High
        "0.01575800",      // Low
        "0.01577100",      // Close
        "148976.11427815", // Volume
        1499644799999,     // Close time
        "2434.19055334",   // Quote asset volume
        308,               // Number of trades
        "1756.87402397",   // Taker buy base asset volume
        "28.46694368",     // Taker buy quote asset volume
        "0"                // Ignore
    ]
]
```
