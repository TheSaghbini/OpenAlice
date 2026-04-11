/**
 * Hyperliquid-specific overrides for CcxtBroker.
 *
 * Hyperliquid quirks:
 * - No native market orders. CCXT emulates them as IOC limit orders with
 *   a slippage-bounded price (default 5%). To compute the bound, CCXT
 *   requires the caller to pass a reference price even for type='market'.
 * - Server enforces an 80% deviation cap from mark price, so we can't
 *   just send an extreme dummy value — we have to fetchTicker first.
 */

import type { Exchange, Order as CcxtOrder } from 'ccxt'
import type { CcxtExchangeOverrides } from '../overrides.js'

export const hyperliquidOverrides: CcxtExchangeOverrides = {
  async placeOrder(
    exchange: Exchange,
    symbol: string,
    type: string,
    side: 'buy' | 'sell',
    amount: number,
    price: number | undefined,
    params: Record<string, unknown>,
  ): Promise<CcxtOrder> {
    let refPrice = price
    if (type === 'market' && refPrice === undefined) {
      const ticker = await exchange.fetchTicker(symbol)
      refPrice = ticker.last ?? ticker.close ?? undefined
      if (refPrice === undefined) {
        throw new Error(`hyperliquid: cannot fetch reference price for market order on ${symbol}`)
      }
    }
    return await exchange.createOrder(symbol, type, side, amount, refPrice, params)
  },
}
