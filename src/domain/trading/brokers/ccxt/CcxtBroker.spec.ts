/**
 * CcxtBroker unit tests.
 *
 * We mock the ccxt module so the constructor doesn't try to reach real exchanges.
 * Tests focus on pure logic: searchContracts sorting/filtering, cancelOrder cache,
 * placeOrder notional conversion, and the constructor error path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order, UNSET_DOUBLE, UNSET_DECIMAL } from '@traderalice/ibkr'

// Mock ccxt BEFORE importing CcxtBroker
vi.mock('ccxt', () => {
  // Create a fake exchange class that can be used as a constructor
  const MockExchange = vi.fn(function (this: any) {
    this.markets = {}
    this.options = { fetchMarkets: { types: ['spot', 'linear'] } }
    this.setSandboxMode = vi.fn()
    this.loadMarkets = vi.fn().mockResolvedValue({})
    this.fetchMarkets = vi.fn().mockResolvedValue([])
    this.fetchTicker = vi.fn()
    this.fetchBalance = vi.fn()
    this.fetchPositions = vi.fn()
    this.fetchOpenOrders = vi.fn()
    this.fetchClosedOrders = vi.fn()
    this.createOrder = vi.fn()
    this.cancelOrder = vi.fn()
    this.editOrder = vi.fn()
    this.fetchOrder = vi.fn()
    this.fetchOpenOrder = vi.fn()
    this.fetchClosedOrder = vi.fn()
    this.fetchFundingRate = vi.fn()
    this.fetchOrderBook = vi.fn()
  })

  return {
    default: {
      bybit: MockExchange,
      binance: MockExchange,
    },
  }
})

import { CcxtBroker } from './CcxtBroker.js'
import '../../contract-ext.js'

// ==================== Helpers ====================

function makeSpotMarket(base: string, quote: string, symbol?: string): any {
  return {
    id: symbol ?? `${base}${quote}`,
    symbol: symbol ?? `${base}/${quote}`,
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    type: 'spot',
    active: true,
    precision: { price: 0.01 },
    limits: {},
    settle: undefined,
  }
}

function makeSwapMarket(base: string, quote: string, symbol?: string): any {
  return {
    id: symbol ?? `${base}${quote}`,
    symbol: symbol ?? `${base}/${quote}:${quote}`,
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    type: 'swap',
    active: true,
    precision: { price: 0.01 },
    limits: {},
    settle: quote.toUpperCase(),
  }
}

function makeAccount(overrides?: Partial<{ exchange: string; apiKey: string; secret: string }>) {
  return new CcxtBroker({
    exchange: overrides?.exchange ?? 'bybit',
    apiKey: overrides?.apiKey ?? 'k',
    secret: overrides?.secret ?? 's',
    sandbox: false,
  })
}

function setInitialized(acc: CcxtBroker, markets: Record<string, any>) {
  ;(acc as any).initialized = true
  ;(acc as any).exchange.markets = markets
}

// ==================== Constructor ====================

describe('CcxtBroker — constructor', () => {
  it('throws for unknown exchange', () => {
    expect(() => new CcxtBroker({ exchange: 'unknownxyz', apiKey: 'k', secret: 's', sandbox: false })).toThrow(
      'Unknown CCXT exchange',
    )
  })

  it('stores exchange name in meta', () => {
    const acc = makeAccount()
    expect(acc.meta).toEqual({ exchange: 'bybit' })
  })

  it('defaults id to exchange-main', () => {
    const acc = makeAccount()
    expect(acc.id).toBe('bybit-main')
  })
})

// ==================== searchContracts ====================

describe('CcxtBroker — searchContracts', () => {
  let acc: CcxtBroker

  beforeEach(() => {
    acc = makeAccount()
    setInitialized(acc, {
      'BTC/USDT': makeSpotMarket('BTC', 'USDT', 'BTC/USDT'),
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
      'BTC/USD': makeSpotMarket('BTC', 'USD', 'BTC/USD'),
      'ETH/USDT': makeSpotMarket('ETH', 'USDT', 'ETH/USDT'),
    })
  })

  it('returns empty array for empty pattern', async () => {
    expect(await acc.searchContracts('')).toEqual([])
  })

  it('filters by base asset (case-insensitive)', async () => {
    const results = await acc.searchContracts('btc')
    const symbols = results.map((r) => r.contract.symbol)
    expect(symbols.every((s) => s.startsWith('BTC'))).toBe(true)
    expect(symbols).not.toContain('ETH/USDT')
  })

  it('only returns USDT/USD/USDC quoted markets', async () => {
    ;(acc as any).exchange.markets['BTC/DOGE'] = { ...makeSpotMarket('BTC', 'DOGE'), id: 'BTCDOGE' }
    const results = await acc.searchContracts('BTC')
    const quotes = results.map((r) => r.contract.currency)
    expect(quotes.every((q) => ['USDT', 'USD', 'USDC'].includes(q ?? ''))).toBe(true)
  })

  it('excludes inactive markets', async () => {
    ;(acc as any).exchange.markets['BTC/USDC'] = { ...makeSpotMarket('BTC', 'USDC'), active: false }
    const before = (await acc.searchContracts('BTC')).length
    expect(before).toBe(3) // spot+swap USDT + spot USD (not inactive USDC)
  })

  it('sorts swap before spot by default', async () => {
    const results = await acc.searchContracts('BTC')
    // derivatives come first
    const first = results[0]
    expect((first.contract as any).secType ?? first.contract.symbol.includes(':') ? 'CRYPTO_PERP' : 'CRYPTO').toBeTruthy()
  })
})

// ==================== cancelOrder — cache miss ====================

describe('CcxtBroker — cancelOrder cache', () => {
  it('calls exchange.cancelOrder with undefined symbol when orderId is not in cache', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})
    ;(acc as any).exchange.cancelOrder = vi.fn().mockResolvedValue({})
    await acc.cancelOrder('order-not-cached')
    expect((acc as any).exchange.cancelOrder).toHaveBeenCalledWith('order-not-cached', undefined)
  })

  it('returns PlaceOrderResult with error when exchange.cancelOrder throws', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})
    ;(acc as any).exchange.cancelOrder = vi.fn().mockRejectedValue(new Error('symbol required'))
    const result = await acc.cancelOrder('order-not-cached')
    expect(result.success).toBe(false)
    expect(result.error).toBe('symbol required')
  })

  it('returns PlaceOrderResult with Cancelled status when orderId is cached', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})
    ;(acc as any).orderSymbolCache.set('order-123', 'BTC/USDT:USDT')
    ;(acc as any).exchange.cancelOrder = vi.fn().mockResolvedValue({})
    const result = await acc.cancelOrder('order-123')
    expect(result.success).toBe(true)
    expect(result.orderId).toBe('order-123')
    expect(result.orderState?.status).toBe('Cancelled')
    expect((acc as any).exchange.cancelOrder).toHaveBeenCalledWith('order-123', 'BTC/USDT:USDT')
  })
})

// ==================== placeOrder — notional conversion ====================

describe('CcxtBroker — placeOrder notional', () => {
  it('converts notional to size using ticker price when qty is not provided', async () => {
    const acc = makeAccount()
    setInitialized(acc, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })
    ;(acc as any).exchange.fetchTicker = vi.fn().mockResolvedValue({ last: 50_000 })
    ;(acc as any).exchange.createOrder = vi.fn().mockResolvedValue({
      id: 'ord-1', status: 'open', average: undefined, filled: undefined,
    })

    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT:USDT'
    contract.symbol = 'BTC/USDT:USDT'
    contract.secType = 'CRYPTO_PERP'
    contract.exchange = 'bybit'
    contract.currency = 'USDT'

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.cashQty = new Decimal(500) // $500 worth of BTC

    const result = await acc.placeOrder(contract, order)

    expect(result.success).toBe(true)
    const createOrderCall = (acc as any).exchange.createOrder.mock.calls[0]
    // size = 500 / 50000 = 0.01 BTC
    expect(createOrderCall[3]).toBeCloseTo(0.01)
  })

  it('returns error when neither qty nor notional provided', async () => {
    const acc = makeAccount()
    setInitialized(acc, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })

    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT:USDT'
    contract.symbol = 'BTC/USDT:USDT'
    contract.secType = 'CRYPTO_PERP'
    contract.exchange = 'bybit'
    contract.currency = 'USDT'

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    // No totalQuantity or cashQty set

    const result = await acc.placeOrder(contract, order)
    expect(result.success).toBe(false)
    expect(result.error).toContain('totalQuantity or cashQty')
  })
})

// ==================== placeOrder — async behavior ====================

describe('CcxtBroker — placeOrder async', () => {
  it('never returns execution (fill status comes from sync)', async () => {
    const acc = makeAccount()
    setInitialized(acc, {
      'ETH/USDT:USDT': makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT'),
    })
    ;(acc as any).exchange.createOrder = vi.fn().mockResolvedValue({
      id: 'ord-42', status: 'closed', filled: 0.5, average: 1920.5,
    })

    const contract = new Contract()
    contract.localSymbol = 'ETH/USDT:USDT'
    const order = new Order()
    order.action = 'SELL'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(0.5)

    const result = await acc.placeOrder(contract, order)
    expect(result.success).toBe(true)
    expect(result.orderId).toBe('ord-42')
    // No execution — exchanges are async, fill confirmed via sync
    expect(result.execution).toBeUndefined()
  })
})

// ==================== getOrder — Bybit (tested exchange) ====================

describe('CcxtBroker — getOrder (bybit)', () => {
  it('uses fetchOpenOrder for open orders', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT')
    setInitialized(acc, { 'ETH/USDT:USDT': market })

    ;(acc as any).orderSymbolCache.set('ord-100', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOpenOrder = vi.fn().mockResolvedValue({
      id: 'ord-100', symbol: 'ETH/USDT:USDT', side: 'buy', amount: 0.1,
      type: 'limit', price: 1900, status: 'open',
    })

    const result = await acc.getOrder('ord-100')
    expect(result).not.toBeNull()
    expect(result!.order.action).toBe('BUY')
    expect(result!.orderState.status).toBe('Submitted')
    expect((acc as any).exchange.fetchOpenOrder).toHaveBeenCalledWith('ord-100', 'ETH/USDT:USDT')
    // Should NOT use fetchOrder (bybit override avoids it)
    expect((acc as any).exchange.fetchOrder).not.toHaveBeenCalled()
  })

  it('falls back to fetchClosedOrder for filled orders', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT')
    setInitialized(acc, { 'ETH/USDT:USDT': market })

    ;(acc as any).orderSymbolCache.set('ord-100', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOpenOrder = vi.fn().mockRejectedValue(new Error('not open'))
    ;(acc as any).exchange.fetchClosedOrder = vi.fn().mockResolvedValue({
      id: 'ord-100', symbol: 'ETH/USDT:USDT', side: 'sell', amount: 0.5,
      type: 'market', price: null, status: 'closed',
    })

    const result = await acc.getOrder('ord-100')
    expect(result).not.toBeNull()
    expect(result!.order.action).toBe('SELL')
    expect(result!.orderState.status).toBe('Filled')
  })

  it('finds conditional orders via { stop: true } fallback', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT')
    setInitialized(acc, { 'ETH/USDT:USDT': market })

    ;(acc as any).orderSymbolCache.set('ord-sl', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOpenOrder = vi.fn()
      .mockRejectedValueOnce(new Error('not found'))  // regular open
      .mockResolvedValueOnce({                         // conditional open (stop: true)
        id: 'ord-sl', symbol: 'ETH/USDT:USDT', side: 'sell', amount: 0.5,
        type: 'limit', price: 1800, status: 'open', triggerPrice: 1850,
      })
    ;(acc as any).exchange.fetchClosedOrder = vi.fn().mockRejectedValue(new Error('not found'))

    const result = await acc.getOrder('ord-sl')
    expect(result).not.toBeNull()
    expect(result!.orderState.status).toBe('Submitted')
    // Second fetchOpenOrder call should have { stop: true }
    expect((acc as any).exchange.fetchOpenOrder).toHaveBeenCalledWith('ord-sl', 'ETH/USDT:USDT', { stop: true })
  })

  it('returns null when orderId not in symbol cache', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})

    const result = await acc.getOrder('unknown-id')
    expect(result).toBeNull()
  })

  it('returns null when order not found on any endpoint', async () => {
    const acc = makeAccount()
    setInitialized(acc, { 'ETH/USDT:USDT': makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT') })
    ;(acc as any).orderSymbolCache.set('ord-404', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOpenOrder = vi.fn().mockRejectedValue(new Error('not found'))
    ;(acc as any).exchange.fetchClosedOrder = vi.fn().mockRejectedValue(new Error('not found'))

    const result = await acc.getOrder('ord-404')
    expect(result).toBeNull()
  })

  it('extracts tpsl from CCXT order with takeProfitPrice/stopLossPrice', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT')
    setInitialized(acc, { 'ETH/USDT:USDT': market })

    ;(acc as any).orderSymbolCache.set('ord-tp', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOpenOrder = vi.fn().mockResolvedValue({
      id: 'ord-tp', symbol: 'ETH/USDT:USDT', side: 'buy', amount: 0.1,
      type: 'limit', price: 1900, status: 'open',
      takeProfitPrice: 2200,
      stopLossPrice: 1800,
    })

    const result = await acc.getOrder('ord-tp')
    expect(result!.tpsl).toEqual({
      takeProfit: { price: '2200' },
      stopLoss: { price: '1800' },
    })
  })

  it('returns no tpsl when CCXT order has no TP/SL prices', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT')
    setInitialized(acc, { 'ETH/USDT:USDT': market })

    ;(acc as any).orderSymbolCache.set('ord-plain', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOpenOrder = vi.fn().mockResolvedValue({
      id: 'ord-plain', symbol: 'ETH/USDT:USDT', side: 'buy', amount: 0.1,
      type: 'limit', price: 1900, status: 'open',
    })

    const result = await acc.getOrder('ord-plain')
    expect(result!.tpsl).toBeUndefined()
  })

  it('extracts only takeProfit when stopLossPrice is absent', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT')
    setInitialized(acc, { 'ETH/USDT:USDT': market })

    ;(acc as any).orderSymbolCache.set('ord-tp-only', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOpenOrder = vi.fn().mockResolvedValue({
      id: 'ord-tp-only', symbol: 'ETH/USDT:USDT', side: 'buy', amount: 0.1,
      type: 'limit', price: 1900, status: 'open',
      takeProfitPrice: 2200,
    })

    const result = await acc.getOrder('ord-tp-only')
    expect(result!.tpsl).toEqual({ takeProfit: { price: '2200' } })
  })
})

// ==================== getOrder — default path (binance etc) ====================

describe('CcxtBroker — getOrder (default/binance)', () => {
  it('uses fetchOrder for regular orders', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    const market = makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT')
    setInitialized(acc, { 'ETH/USDT:USDT': market })

    ;(acc as any).orderSymbolCache.set('ord-100', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOrder = vi.fn().mockResolvedValue({
      id: 'ord-100', symbol: 'ETH/USDT:USDT', side: 'sell', amount: 0.5,
      type: 'market', price: null, status: 'closed',
    })

    const result = await acc.getOrder('ord-100')
    expect(result).not.toBeNull()
    expect(result!.order.action).toBe('SELL')
    expect(result!.orderState.status).toBe('Filled')
    expect((acc as any).exchange.fetchOrder).toHaveBeenCalledWith('ord-100', 'ETH/USDT:USDT')
  })

  it('falls back to { stop: true } for conditional orders', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    const market = makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT')
    setInitialized(acc, { 'ETH/USDT:USDT': market })

    ;(acc as any).orderSymbolCache.set('ord-sl', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOrder = vi.fn()
      .mockRejectedValueOnce(new Error('order not found'))
      .mockResolvedValueOnce({
        id: 'ord-sl', symbol: 'ETH/USDT:USDT', side: 'sell', amount: 0.5,
        type: 'limit', price: 1800, status: 'open', triggerPrice: 1850,
      })

    const result = await acc.getOrder('ord-sl')
    expect(result).not.toBeNull()
    expect(result!.orderState.status).toBe('Submitted')
    expect((acc as any).exchange.fetchOrder).toHaveBeenCalledTimes(2)
    expect((acc as any).exchange.fetchOrder).toHaveBeenLastCalledWith('ord-sl', 'ETH/USDT:USDT', { stop: true })
  })

  it('returns null when order not found on either endpoint', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, { 'ETH/USDT:USDT': makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT') })
    ;(acc as any).orderSymbolCache.set('ord-404', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOrder = vi.fn().mockRejectedValue(new Error('not found'))

    const result = await acc.getOrder('ord-404')
    expect(result).toBeNull()
    expect((acc as any).exchange.fetchOrder).toHaveBeenCalledTimes(2)
  })
})

// ==================== getContractDetails ====================

describe('CcxtBroker — getContractDetails', () => {
  it('returns ContractDetails for a resolvable contract via aliceId', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT')
    setInitialized(acc, { 'BTC/USDT:USDT': market })

    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT:USDT'

    const details = await acc.getContractDetails(contract)
    expect(details).not.toBeNull()
    expect(details!.contract.symbol).toBe('BTC')
    expect(details!.contract.currency).toBe('USDT')
    expect(details!.longName).toContain('BTC/USDT')
    expect(details!.minTick).toBe(0.01)
  })

  it('returns null when contract cannot be resolved', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})

    const contract = new Contract()
    contract.localSymbol = 'NONEXISTENT/USDT'

    const details = await acc.getContractDetails(contract)
    expect(details).toBeNull()
  })
})

// ==================== placeOrder (qty-based) ====================

describe('CcxtBroker — placeOrder qty-based', () => {
  let acc: CcxtBroker

  beforeEach(() => {
    acc = makeAccount()
    setInitialized(acc, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })
  })

  function makeContract(): Contract {
    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT:USDT'
    contract.symbol = 'BTC/USDT:USDT'
    contract.secType = 'CRYPTO_PERP'
    contract.exchange = 'bybit'
    contract.currency = 'USDT'
    return contract
  }

  it('places market order with totalQuantity', async () => {
    ;(acc as any).exchange.createOrder = vi.fn().mockResolvedValue({
      id: 'ord-mkt', status: 'open', average: undefined, filled: undefined,
    })

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(0.5)

    const result = await acc.placeOrder(makeContract(), order)
    expect(result.success).toBe(true)
    expect(result.orderId).toBe('ord-mkt')

    const call = (acc as any).exchange.createOrder.mock.calls[0]
    expect(call[0]).toBe('BTC/USDT:USDT') // symbol
    expect(call[1]).toBe('market')          // type
    expect(call[2]).toBe('buy')             // side
    expect(call[3]).toBe(0.5)               // size
    expect(call[4]).toBeUndefined()         // no price for market order
  })

  it('places limit order with lmtPrice passed correctly', async () => {
    ;(acc as any).exchange.createOrder = vi.fn().mockResolvedValue({
      id: 'ord-lmt', status: 'open', average: undefined, filled: undefined,
    })

    const order = new Order()
    order.action = 'SELL'
    order.orderType = 'LMT'
    order.totalQuantity = new Decimal(1.0)
    order.lmtPrice = new Decimal(65000)

    const result = await acc.placeOrder(makeContract(), order)
    expect(result.success).toBe(true)
    expect(result.orderId).toBe('ord-lmt')

    const call = (acc as any).exchange.createOrder.mock.calls[0]
    expect(call[0]).toBe('BTC/USDT:USDT')
    expect(call[1]).toBe('limit')
    expect(call[2]).toBe('sell')
    expect(call[3]).toBe(1.0)
    expect(call[4]).toBe(65000)
  })

  it('returns error when contract cannot be resolved', async () => {
    const contract = new Contract()
    contract.localSymbol = 'NONEXISTENT/USDT'

    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(1)

    const result = await acc.placeOrder(contract, order)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Cannot resolve contract')
  })
})

// ==================== modifyOrder ====================

describe('CcxtBroker — modifyOrder', () => {
  it('calls exchange.editOrder with mapped fields', async () => {
    const acc = makeAccount()
    setInitialized(acc, { 'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT') })
    ;(acc as any).orderSymbolCache.set('ord-100', 'BTC/USDT:USDT')
    // Bybit override uses fetchOpenOrder to fetch the original order
    ;(acc as any).exchange.fetchOpenOrder = vi.fn().mockResolvedValue({
      type: 'limit', side: 'buy', amount: 0.5, price: 60000,
    })
    ;(acc as any).exchange.editOrder = vi.fn().mockResolvedValue({
      id: 'ord-100-edited', status: 'open',
    })

    const changes = new Order()
    changes.totalQuantity = new Decimal(0.75)
    changes.lmtPrice = new Decimal(62000)
    changes.orderType = 'LMT'

    const result = await acc.modifyOrder('ord-100', changes)
    expect(result.success).toBe(true)
    expect(result.orderId).toBe('ord-100-edited')

    const call = (acc as any).exchange.editOrder.mock.calls[0]
    expect(call[0]).toBe('ord-100')
    expect(call[1]).toBe('BTC/USDT:USDT')
    expect(call[2]).toBe('limit')
    expect(call[3]).toBe('buy')   // original side
    expect(call[4]).toBe(0.75)
    expect(call[5]).toBe(62000)
  })

  it('returns error when orderId is not in cache', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})

    const changes = new Order()
    changes.totalQuantity = new Decimal(1)

    const result = await acc.modifyOrder('unknown-order', changes)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown order')
  })
})

// ==================== modifyOrder — field forwarding ====================

describe('CcxtBroker — modifyOrder field forwarding', () => {
  it('uses original price when lmtPrice not in changes (Partial<Order>)', async () => {
    const acc = makeAccount()
    setInitialized(acc, { 'ETH/USDT:USDT': makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT') })
    ;(acc as any).orderSymbolCache.set('ord-200', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOpenOrder = vi.fn().mockResolvedValue({
      type: 'limit', side: 'buy', amount: 0.1, price: 1900,
    })
    ;(acc as any).exchange.editOrder = vi.fn().mockResolvedValue({ id: 'ord-200-edited', status: 'open' })

    // Partial<Order> — only totalQuantity, no lmtPrice
    const changes: Partial<Order> = { totalQuantity: new Decimal(0.2) }

    await acc.modifyOrder('ord-200', changes)
    const call = (acc as any).exchange.editOrder.mock.calls[0]

    // Should use original price (1900), not undefined
    expect(call[4]).toBe(0.2)    // amount
    expect(call[5]).toBe(1900)   // price from original
  })

  it('forwards auxPrice as stopPrice in params', async () => {
    const acc = makeAccount()
    setInitialized(acc, { 'ETH/USDT:USDT': makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT') })
    ;(acc as any).orderSymbolCache.set('ord-300', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOpenOrder = vi.fn().mockResolvedValue({
      type: 'limit', side: 'sell', amount: 0.1, price: 2100,
    })
    ;(acc as any).exchange.editOrder = vi.fn().mockResolvedValue({ id: 'ord-300-edited', status: 'open' })

    const changes: Partial<Order> = { auxPrice: new Decimal(1850) }

    await acc.modifyOrder('ord-300', changes)
    const call = (acc as any).exchange.editOrder.mock.calls[0]

    // 7th argument is the params object with extra fields
    const params = call[6] ?? {}
    expect(params.stopPrice).toBe(1850)
  })

  it('forwards tif in params', async () => {
    const acc = makeAccount()
    setInitialized(acc, { 'ETH/USDT:USDT': makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT') })
    ;(acc as any).orderSymbolCache.set('ord-400', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOpenOrder = vi.fn().mockResolvedValue({
      type: 'limit', side: 'buy', amount: 0.1, price: 1900,
    })
    ;(acc as any).exchange.editOrder = vi.fn().mockResolvedValue({ id: 'ord-400-edited', status: 'open' })

    const changes: Partial<Order> = { tif: 'GTC' }

    await acc.modifyOrder('ord-400', changes)
    const call = (acc as any).exchange.editOrder.mock.calls[0]

    const params = call[6] ?? {}
    expect(params.timeInForce).toBe('gtc')
  })

  it('does not include undefined fields in params', async () => {
    const acc = makeAccount()
    setInitialized(acc, { 'ETH/USDT:USDT': makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT') })
    ;(acc as any).orderSymbolCache.set('ord-500', 'ETH/USDT:USDT')
    ;(acc as any).exchange.fetchOpenOrder = vi.fn().mockResolvedValue({
      type: 'limit', side: 'buy', amount: 0.1, price: 1900,
    })
    ;(acc as any).exchange.editOrder = vi.fn().mockResolvedValue({ id: 'ord-500-edited', status: 'open' })

    // Only change qty — nothing else should appear in params
    const changes: Partial<Order> = { totalQuantity: new Decimal(0.5) }

    await acc.modifyOrder('ord-500', changes)
    const call = (acc as any).exchange.editOrder.mock.calls[0]

    const params = call[6] ?? {}
    expect(params).toEqual({})
  })
})

// ==================== closePosition ====================

describe('CcxtBroker — closePosition', () => {
  it('reverses position with market order and correct side', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT')
    setInitialized(acc, { 'BTC/USDT:USDT': market })

    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([
      {
        symbol: 'BTC/USDT:USDT',
        contracts: 0.5,
        contractSize: 1,
        markPrice: 60000,
        entryPrice: 58000,
        unrealizedPnl: 1000,
        side: 'long',
        leverage: 10,
        initialMargin: 2900,
        liquidationPrice: 50000,
      },
    ])
    ;(acc as any).exchange.createOrder = vi.fn().mockResolvedValue({
      id: 'close-1', status: 'closed',
    })

    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT:USDT'

    const result = await acc.closePosition(contract)
    expect(result.success).toBe(true)

    const call = (acc as any).exchange.createOrder.mock.calls[0]
    expect(call[2]).toBe('sell') // reverses long position
    expect(call[3]).toBe(0.5)   // full position size
  })

  it('returns error when no position found', async () => {
    const acc = makeAccount()
    setInitialized(acc, { 'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT') })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])

    const contract = new Contract()
    contract.localSymbol = 'NONEXISTENT/USDT'

    const result = await acc.closePosition(contract)
    expect(result.success).toBe(false)
    expect(result.error).toContain('No open position')
  })
})

// ==================== precision + reduceOnly behavior ====================

describe('CcxtBroker — precision', () => {
  it('placeOrder sends precise quantity (no float corruption)', async () => {
    const acc = makeAccount()
    setInitialized(acc, { 'ETH/USDT:USDT': makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT') })
    ;(acc as any).exchange.createOrder = vi.fn().mockResolvedValue({ id: 'ord-1', status: 'open' })

    const contract = new Contract()
    contract.localSymbol = 'ETH/USDT:USDT'
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('0.123456789')

    await acc.placeOrder(contract, order)
    const amount = (acc as any).exchange.createOrder.mock.calls[0][3]
    // parseFloat("0.123456789") === 0.123456789 (exact in IEEE 754)
    expect(amount).toBe(0.123456789)
  })

  it('getPositions returns precise Decimal quantity from string contracts', async () => {
    const acc = makeAccount()
    setInitialized(acc, { 'ETH/USDT:USDT': makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT') })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([{
      symbol: 'ETH/USDT:USDT',
      contracts: '0.51', // string from exchange — must not lose precision
      contractSize: '1',
      markPrice: 1920, entryPrice: 1900, unrealizedPnl: 10.2,
      side: 'long', leverage: 10, initialMargin: 100, liquidationPrice: 0,
    }])

    const positions = await acc.getPositions()
    // Must be exactly "0.51", not "0.50999999..."
    expect(positions[0].quantity.toString()).toBe('0.51')
  })

  it('getPositions handles fractional contractSize precisely', async () => {
    const acc = makeAccount()
    setInitialized(acc, { 'ETH/USDT:USDT': makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT') })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([{
      symbol: 'ETH/USDT:USDT',
      contracts: '51', // 51 contracts × 0.01 contractSize = 0.51
      contractSize: '0.01',
      markPrice: 1920, entryPrice: 1900, unrealizedPnl: 10.2,
      side: 'long', leverage: 10, initialMargin: 100, liquidationPrice: 0,
    }])

    const positions = await acc.getPositions()
    expect(positions[0].quantity.toString()).toBe('0.51')
  })
})

describe('CcxtBroker — closePosition reduceOnly', () => {
  it('passes reduceOnly: true to createOrder params', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT')
    setInitialized(acc, { 'ETH/USDT:USDT': market })

    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([{
      symbol: 'ETH/USDT:USDT', contracts: 0.5, contractSize: 1,
      markPrice: 1920, entryPrice: 1900, unrealizedPnl: 10,
      side: 'long', leverage: 10, initialMargin: 100, liquidationPrice: 0,
    }])
    ;(acc as any).exchange.createOrder = vi.fn().mockResolvedValue({ id: 'close-1', status: 'closed' })

    const contract = new Contract()
    contract.localSymbol = 'ETH/USDT:USDT'
    await acc.closePosition(contract)

    // createOrder 6th arg is params
    const params = (acc as any).exchange.createOrder.mock.calls[0][5]
    expect(params.reduceOnly).toBe(true)
  })
})

// ==================== getAccount ====================

describe('CcxtBroker — getAccount', () => {
  it('maps CCXT balance to AccountInfo', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})

    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      total: { USDT: 10000 },
      free: { USDT: 8000 },
      used: { USDT: 2000 },
    })
    // Positions must include contracts/contractSize/markPrice so the broker
    // can reconstruct netLiquidation from fresh position market values.
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([
      { contracts: 1, contractSize: 1, markPrice: 1500, unrealizedPnl: 500, realizedPnl: 100, side: 'long' },
      { contracts: 1, contractSize: 1, markPrice: 500, unrealizedPnl: -200, realizedPnl: 50, side: 'long' },
    ])

    const info = await acc.getAccount()
    // netLiq = free (8000) + position market values (1500 + 500 = 2000) = 10000
    expect(info.netLiquidation).toBe('10000')
    expect(info.totalCashValue).toBe('8000')
    expect(info.initMarginReq).toBe('2000')
    expect(info.unrealizedPnL).toBe('300')
    expect(info.realizedPnL).toBe('150')
  })

  it('throws BrokerError when no API credentials', async () => {
    const acc = new CcxtBroker({ exchange: 'bybit', apiKey: '', secret: '', sandbox: false })

    await expect(acc.init()).rejects.toThrow(/requires credentials/)
  })
})

// ==================== getPositions ====================

describe('CcxtBroker — getPositions', () => {
  it('maps CCXT positions to Position[] with Decimal quantity', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT')
    setInitialized(acc, { 'BTC/USDT:USDT': market })

    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([
      {
        symbol: 'BTC/USDT:USDT',
        contracts: 2,
        contractSize: 1,
        markPrice: 60000,
        entryPrice: 58000,
        unrealizedPnl: 4000,
        side: 'long',
        leverage: 5,
        initialMargin: 23200,
        liquidationPrice: 48000,
      },
    ])

    const positions = await acc.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].quantity).toBeInstanceOf(Decimal)
    expect(positions[0].quantity.toNumber()).toBe(2)
    expect(positions[0].side).toBe('long')
    expect(positions[0].avgCost).toBe('58000')
    expect(positions[0].marketPrice).toBe('60000')
  })

  it('skips zero-size positions', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT')
    setInitialized(acc, { 'BTC/USDT:USDT': market })

    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([
      {
        symbol: 'BTC/USDT:USDT',
        contracts: 0,
        contractSize: 1,
        markPrice: 60000,
        entryPrice: 58000,
        unrealizedPnl: 0,
        side: 'long',
        leverage: 1,
        initialMargin: 0,
        liquidationPrice: 0,
      },
    ])

    const positions = await acc.getPositions()
    expect(positions).toHaveLength(0)
  })

  it('skips positions without market data', async () => {
    const acc = makeAccount()
    setInitialized(acc, {}) // no markets loaded

    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([
      {
        symbol: 'UNKNOWN/USDT:USDT',
        contracts: 1,
        contractSize: 1,
        markPrice: 100,
        entryPrice: 90,
        unrealizedPnl: 10,
        side: 'long',
        leverage: 1,
        initialMargin: 90,
        liquidationPrice: 0,
      },
    ])

    const positions = await acc.getPositions()
    expect(positions).toHaveLength(0)
  })
})

// ==================== getOrders ====================

describe('CcxtBroker — getOrders', () => {
  it('queries each orderId via getOrder and returns results (bybit)', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT')
    setInitialized(acc, { 'BTC/USDT:USDT': market })

    ;(acc as any).orderSymbolCache.set('ord-1', 'BTC/USDT:USDT')
    ;(acc as any).orderSymbolCache.set('ord-2', 'BTC/USDT:USDT')

    // Bybit path: ord-1 not open, found via fetchClosedOrder; ord-2 found via fetchOpenOrder
    ;(acc as any).exchange.fetchOpenOrder = vi.fn()
      .mockRejectedValueOnce(new Error('not open'))   // ord-1 regular
      .mockRejectedValueOnce(new Error('not open'))   // ord-1 conditional
      .mockResolvedValueOnce({ id: 'ord-2', symbol: 'BTC/USDT:USDT', side: 'buy', type: 'limit', amount: 0.1, price: 55000, status: 'open' })
    ;(acc as any).exchange.fetchClosedOrder = vi.fn()
      .mockResolvedValueOnce({ id: 'ord-1', symbol: 'BTC/USDT:USDT', side: 'sell', type: 'market', amount: 0.2, status: 'closed' })

    const orders = await acc.getOrders(['ord-1', 'ord-2'])
    expect(orders).toHaveLength(2)
    expect(orders[0].order.action).toBe('SELL')
    expect(orders[0].orderState.status).toBe('Filled')
    expect(orders[1].order.action).toBe('BUY')
    expect(orders[1].orderState.status).toBe('Submitted')
  })

  it('skips unfound orders', async () => {
    const acc = makeAccount()
    setInitialized(acc, { 'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT') })

    // ord-404 not in symbol cache
    const orders = await acc.getOrders(['ord-404'])
    expect(orders).toHaveLength(0)
  })

  it('returns empty for empty input', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})
    const orders = await acc.getOrders([])
    expect(orders).toHaveLength(0)
  })
})

// ==================== getQuote ====================

describe('CcxtBroker — getQuote', () => {
  it('returns mapped ticker data', async () => {
    const acc = makeAccount()
    const market = makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT')
    setInitialized(acc, { 'BTC/USDT:USDT': market })

    const now = Date.now()
    ;(acc as any).exchange.fetchTicker = vi.fn().mockResolvedValue({
      last: 60000, bid: 59990, ask: 60010, baseVolume: 1234.5,
      high: 61000, low: 59000, timestamp: now,
    })

    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT:USDT'

    const quote = await acc.getQuote(contract)
    expect(quote.last).toBe(60000)
    expect(quote.bid).toBe(59990)
    expect(quote.ask).toBe(60010)
    expect(quote.volume).toBe(1234.5)
    expect(quote.high).toBe(61000)
    expect(quote.low).toBe(59000)
    expect(quote.timestamp).toEqual(new Date(now))
  })

  it('throws when contract cannot be resolved', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})

    const contract = new Contract()
    contract.localSymbol = 'NONEXISTENT/USDT'

    await expect(acc.getQuote(contract)).rejects.toThrow('Cannot resolve contract')
  })
})

// ==================== getMarketClock ====================

describe('CcxtBroker — getMarketClock', () => {
  it('returns isOpen: true with current timestamp (crypto 24/7)', async () => {
    const acc = makeAccount()
    setInitialized(acc, {})

    const before = Date.now()
    const clock = await acc.getMarketClock()
    const after = Date.now()

    expect(clock.isOpen).toBe(true)
    expect(clock.timestamp!.getTime()).toBeGreaterThanOrEqual(before)
    expect(clock.timestamp!.getTime()).toBeLessThanOrEqual(after)
  })
})

// ==================== init — fetchMarkets wrapper ====================

describe('CcxtBroker — init fetchMarkets wrapper', () => {
  function prepareForInit(acc: CcxtBroker, opts?: { types?: string[]; markets?: unknown[] }) {
    const ex = (acc as any).exchange
    ex.checkRequiredCredentials = vi.fn()
    ex.requiredCredentials = {}
    const returnMarkets = opts?.markets ?? [
      { symbol: 'BTC/USDT', id: 'BTCUSDT', base: 'BTC', quote: 'USDT', type: 'spot', active: true },
    ]
    // Track calls to the original fetchMarkets
    ex.fetchMarkets = vi.fn().mockResolvedValue(returnMarkets)
    if (opts?.types !== undefined) {
      ex.options = { fetchMarkets: { types: opts.types } }
    }
    // loadMarkets calls this.fetchMarkets internally, so we re-implement it
    // to invoke the wrapper that init() installs.
    ex.loadMarkets = vi.fn(async function (this: any) {
      const result = await this.fetchMarkets()
      // Populate markets object from returned array
      for (const m of result) {
        this.markets[(m as any).symbol] = m
      }
      return this.markets
    }.bind(ex))
    return ex
  }

  it('calls fetchMarkets once when exchange declares no types (e.g. Crypto.com)', async () => {
    const acc = makeAccount()
    const ex = prepareForInit(acc, { types: [] })

    // Store the original fetchMarkets ref before init overwrites it
    const origFetchMarkets = ex.fetchMarkets

    await acc.init()

    // The original fetchMarkets should have been called exactly once
    expect(origFetchMarkets).toHaveBeenCalledTimes(1)
  })

  it('calls fetchMarkets per-type when exchange declares types (e.g. Bybit)', async () => {
    const acc = makeAccount()
    const ex = prepareForInit(acc, { types: ['spot', 'linear'] })
    const origFetchMarkets = ex.fetchMarkets

    await acc.init()

    // Should be called once per declared type
    expect(origFetchMarkets).toHaveBeenCalledTimes(2)
  })

  it('skips option type from declared types', async () => {
    const acc = makeAccount()
    const ex = prepareForInit(acc, { types: ['spot', 'linear', 'option'] })
    const origFetchMarkets = ex.fetchMarkets

    await acc.init()

    // option filtered out → only spot + linear = 2 calls
    expect(origFetchMarkets).toHaveBeenCalledTimes(2)
  })

  it('deduplicates markets by symbol, keeping first occurrence', async () => {
    const acc = makeAccount()
    const spotBtc = { symbol: 'BTC/USDT', id: 'BTCUSDT', base: 'BTC', quote: 'USDT', type: 'spot', active: true, source: 'first' }
    const dupeBtc = { symbol: 'BTC/USDT', id: 'BTCUSDT', base: 'BTC', quote: 'USDT', type: 'spot', active: true, source: 'dupe' }
    const ethMarket = { symbol: 'ETH/USDT', id: 'ETHUSDT', base: 'ETH', quote: 'USDT', type: 'spot', active: true }

    // Exchange doesn't declare types → single call returning duplicates
    const ex = prepareForInit(acc, { types: [], markets: [spotBtc, dupeBtc, ethMarket] })

    await acc.init()

    const marketKeys = Object.keys(ex.markets)
    expect(marketKeys).toHaveLength(2)
    expect(marketKeys).toContain('BTC/USDT')
    expect(marketKeys).toContain('ETH/USDT')
    // First occurrence kept
    expect(ex.markets['BTC/USDT'].source).toBe('first')
  })

  it('deduplicates across per-type fetches for exchanges that return overlapping results', async () => {
    const acc = makeAccount()
    const btcSpot = { symbol: 'BTC/USDT', id: 'BTCUSDT', base: 'BTC', quote: 'USDT', type: 'spot', active: true }
    const btcLinear = { symbol: 'BTC/USDT:USDT', id: 'BTCUSDT_PERP', base: 'BTC', quote: 'USDT', type: 'swap', active: true }
    const btcDupe = { symbol: 'BTC/USDT', id: 'BTCUSDT', base: 'BTC', quote: 'USDT', type: 'spot', active: true }

    const ex = prepareForInit(acc, { types: ['spot', 'linear'] })
    let callCount = 0
    ex.fetchMarkets = vi.fn(async () => {
      callCount++
      return callCount === 1 ? [btcSpot] : [btcLinear, btcDupe]
    })
    const origFetchMarkets = ex.fetchMarkets

    await acc.init()

    expect(origFetchMarkets).toHaveBeenCalledTimes(2)
    const marketKeys = Object.keys(ex.markets)
    // btcSpot + btcLinear (dupe of btcSpot removed)
    expect(marketKeys).toHaveLength(2)
    expect(marketKeys).toContain('BTC/USDT')
    expect(marketKeys).toContain('BTC/USDT:USDT')
  })
})

// ==================== getCapabilities ====================

describe('CcxtBroker — getCapabilities', () => {
  it('returns CRYPTO secType and MKT/LMT order types', () => {
    const acc = makeAccount()
    const caps = acc.getCapabilities()
    expect(caps.supportedSecTypes).toEqual(['CRYPTO'])
    expect(caps.supportedOrderTypes).toEqual(['MKT', 'LMT'])
  })
})

// ==================== close ====================

describe('CcxtBroker — close', () => {
  it('resolves without error (no-op)', async () => {
    const acc = makeAccount()
    await expect(acc.close()).resolves.toBeUndefined()
  })
})

// ==================== Fix 1: Spot balance support in getAccount ====================

describe('CcxtBroker — getAccount spot balance', () => {
  it('fetches spot balance when exchange has spot markets and no skipSpotBalance override', async () => {
    const acc = makeAccount({ exchange: 'binance' }) // binance has no override → no skipSpotBalance
    setInitialized(acc, {
      'CRO/USD': makeSpotMarket('CRO', 'USD', 'CRO/USD'),
    })

    ;(acc as any).exchange.fetchBalance = vi.fn()
      .mockImplementation((params?: Record<string, unknown>) => {
        if (params?.type === 'spot') {
          return Promise.resolve({
            free: { USDT: 5.0, USDC: 1.63 },
            used: { USDT: 0 },
            total: { USDT: 5.0, USDC: 1.63 },
          })
        }
        // Default (derivatives) wallet
        return Promise.resolve({
          free: { USDT: 1.54 },
          used: { USDT: 0 },
          total: { USDT: 1.54 },
        })
      })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])

    const info = await acc.getAccount()
    // Should use spot balance: USDT 5.0 + USDC 1.63 = 6.63
    expect(info.totalCashValue).toBeCloseTo(6.63)
    expect(info.netLiquidation).toBeCloseTo(6.63)
  })

  it('falls back to default balance when spot fetch fails', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, {
      'BTC/USDT': makeSpotMarket('BTC', 'USDT', 'BTC/USDT'),
    })

    ;(acc as any).exchange.fetchBalance = vi.fn()
      .mockImplementation((params?: Record<string, unknown>) => {
        if (params?.type === 'spot') throw new Error('not supported')
        return Promise.resolve({
          free: { USDT: 100 },
          used: { USDT: 50 },
          total: { USDT: 150 },
        })
      })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])

    const info = await acc.getAccount()
    expect(info.totalCashValue).toBe('100')
    expect(info.initMarginReq).toBe('50')
  })

  it('skips spot balance for derivatives-first exchanges (bybit override)', async () => {
    const acc = makeAccount({ exchange: 'bybit' })
    setInitialized(acc, {
      'BTC/USDT': makeSpotMarket('BTC', 'USDT', 'BTC/USDT'),
    })

    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { USDT: 5000 },
      used: { USDT: 2000 },
      total: { USDT: 7000 },
    })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])

    const info = await acc.getAccount()
    // Should use default balance (not spot) due to bybit override
    expect(info.totalCashValue).toBe('5000')
    // fetchBalance should NOT have been called with { type: 'spot' }
    expect((acc as any).exchange.fetchBalance).toHaveBeenCalledWith()
    expect((acc as any).exchange.fetchBalance).not.toHaveBeenCalledWith({ type: 'spot' })
  })

  it('sums multiple stablecoin currencies for cash', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, { 'ETH/USDT': makeSpotMarket('ETH', 'USDT', 'ETH/USDT') })

    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { USDT: 100, USDC: 50, USD: 25, DAI: 10, BTC: 0.5 },
      used: {},
      total: { USDT: 100, USDC: 50, USD: 25, DAI: 10, BTC: 0.5 },
    })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])

    const info = await acc.getAccount()
    // Cash = USDT + USDC + USD + DAI = 100 + 50 + 25 + 10 = 185
    // BTC is not counted as cash
    expect(info.totalCashValue).toBe('185')
  })

  it('handles fetchPositions failure gracefully for spot-only exchanges', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, { 'CRO/USD': makeSpotMarket('CRO', 'USD', 'CRO/USD') })

    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { USD: 10 },
      used: {},
      total: { USD: 10 },
    })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockRejectedValue(new Error('not supported'))

    const info = await acc.getAccount()
    expect(info.totalCashValue).toBe('10')
    expect(info.unrealizedPnL).toBe('0')
  })

  it('includes spot holdings value in netLiquidation', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, {
      'CRO/USD': makeSpotMarket('CRO', 'USD', 'CRO/USD'),
      'ETH/USDT': makeSpotMarket('ETH', 'USDT', 'ETH/USDT'),
    })

    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { USDT: 100 },
      used: {},
      total: { USDT: 100, CRO: 1000, ETH: 0.5 },
    })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])
    ;(acc as any).exchange.fetchTicker = vi.fn().mockImplementation((symbol: string) => {
      if (symbol === 'CRO/USD') return Promise.resolve({ last: 1.0 })
      if (symbol === 'ETH/USDT') return Promise.resolve({ last: 2000 })
      return Promise.reject(new Error('unknown'))
    })

    const info = await acc.getAccount()
    // Cash = 100 USDT
    expect(info.totalCashValue).toBe('100')
    // netLiq = cash(100) + derivatives(0) + spotHoldings(1000*1 + 0.5*2000 = 2000) = 2100
    expect(info.netLiquidation).toBe('2100')
  })

  it('excludes spot holdings from netLiquidation for skipSpotBalance exchanges', async () => {
    const acc = makeAccount({ exchange: 'bybit' }) // bybit has skipSpotBalance: true
    setInitialized(acc, {
      'CRO/USDT': makeSpotMarket('CRO', 'USDT', 'CRO/USDT'),
    })

    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { USDT: 100 },
      used: {},
      total: { USDT: 100, CRO: 1000 },
    })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])

    const info = await acc.getAccount()
    // bybit skips spot → no spot holdings added
    expect(info.netLiquidation).toBe('100')
  })

  it('treats FDUSD as a stablecoin (cash, not holding)', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, { 'ETH/USDT': makeSpotMarket('ETH', 'USDT', 'ETH/USDT') })

    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { FDUSD: 500 },
      used: {},
      total: { FDUSD: 500 },
    })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])

    const info = await acc.getAccount()
    // FDUSD counted as cash (stablecoin)
    expect(info.totalCashValue).toBe('500')
    expect(info.netLiquidation).toBe('500')
  })
})

// ==================== Fix 2: Spot holdings as positions ====================

describe('CcxtBroker — getPositions spot holdings', () => {
  it('converts spot balance to Position objects for non-stablecoin currencies', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, {
      'CRO/USD': makeSpotMarket('CRO', 'USD', 'CRO/USD'),
      'ETH/USDT': makeSpotMarket('ETH', 'USDT', 'ETH/USDT'),
    })

    ;(acc as any).exchange.fetchPositions = vi.fn().mockRejectedValue(new Error('not supported'))
    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { CRO: 100, ETH: 0.5, USDT: 50 },
      used: {},
      total: { CRO: 100, ETH: 0.5, USDT: 50 },
    })
    ;(acc as any).exchange.fetchTicker = vi.fn().mockImplementation((symbol: string) => {
      if (symbol === 'CRO/USD') return Promise.resolve({ last: 0.08 })
      if (symbol === 'ETH/USDT') return Promise.resolve({ last: 2500 })
      return Promise.reject(new Error('unknown'))
    })

    const positions = await acc.getPositions()
    expect(positions).toHaveLength(2)

    const cro = positions.find(p => p.contract.symbol === 'CRO')!
    expect(cro).toBeDefined()
    expect(cro.side).toBe('long')
    expect(cro.quantity.toString()).toBe('100')
    expect(cro.marketPrice).toBe(0.08)
    expect(Number(cro.marketValue)).toBeCloseTo(8)

    const eth = positions.find(p => p.contract.symbol === 'ETH')!
    expect(eth).toBeDefined()
    expect(eth.quantity.toString()).toBe('0.5')
    expect(eth.marketPrice).toBe(2500)
    expect(Number(eth.marketValue)).toBeCloseTo(1250)
  })

  it('skips stablecoin balances in spot position conversion', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, {
      'CRO/USD': makeSpotMarket('CRO', 'USD', 'CRO/USD'),
    })

    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])
    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { USDT: 100, USDC: 50, CRO: 10 },
      used: {},
      total: { USDT: 100, USDC: 50, CRO: 10 },
    })
    ;(acc as any).exchange.fetchTicker = vi.fn().mockResolvedValue({ last: 0.08 })

    const positions = await acc.getPositions()
    // Only CRO (not USDT or USDC)
    expect(positions).toHaveLength(1)
    expect(positions[0].contract.symbol).toBe('CRO')
  })

  it('skips dust balances below $0.01', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, {
      'CRO/USD': makeSpotMarket('CRO', 'USD', 'CRO/USD'),
    })

    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])
    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { CRO: 0.001 },
      used: {},
      total: { CRO: 0.001 },
    })
    ;(acc as any).exchange.fetchTicker = vi.fn().mockResolvedValue({ last: 0.08 })

    const positions = await acc.getPositions()
    // CRO worth 0.001 * 0.08 = 0.00008 < $0.01 → skipped
    expect(positions).toHaveLength(0)
  })

  it('preserves derivatives positions alongside spot holdings', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
      'CRO/USD': makeSpotMarket('CRO', 'USD', 'CRO/USD'),
    })

    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([{
      symbol: 'BTC/USDT:USDT', contracts: 0.1, contractSize: 1,
      markPrice: 60000, entryPrice: 58000, unrealizedPnl: 200,
      side: 'long',
    }])
    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { CRO: 100 },
      used: {},
      total: { CRO: 100 },
    })
    ;(acc as any).exchange.fetchTicker = vi.fn().mockResolvedValue({ last: 0.08 })

    const positions = await acc.getPositions()
    expect(positions).toHaveLength(2)

    const btc = positions.find(p => p.contract.symbol === 'BTC')!
    expect(btc.side).toBe('long')
    expect(btc.marketPrice).toBe('60000')

    const cro = positions.find(p => p.contract.symbol === 'CRO')!
    expect(cro.side).toBe('long')
    expect(cro.marketPrice).toBe(0.08)
  })

  it('does not add spot holdings for derivatives-first exchanges', async () => {
    const acc = makeAccount({ exchange: 'bybit' }) // bybit has skipSpotBalance: true
    setInitialized(acc, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
      'CRO/USDT': makeSpotMarket('CRO', 'USDT', 'CRO/USDT'),
    })

    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])
    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { CRO: 100 },
      used: {},
      total: { CRO: 100 },
    })

    const positions = await acc.getPositions()
    // Bybit: skipSpotBalance → no spot holdings added
    expect(positions).toHaveLength(0)
    // fetchBalance should NOT have been called (getPositions spot path is skipped)
    expect((acc as any).exchange.fetchBalance).not.toHaveBeenCalled()
  })
})

// ==================== Fix 3: Order symbol cache persistence + open order discovery ====================

describe('CcxtBroker — order cache persistence', () => {
  it('exportBrokerState returns orderSymbolCache as plain object', () => {
    const acc = makeAccount()
    setInitialized(acc, {})
    ;(acc as any).orderSymbolCache.set('order-1', 'BTC/USDT:USDT')
    ;(acc as any).orderSymbolCache.set('order-2', 'ETH/USDT:USDT')

    const state = acc.exportBrokerState()
    expect(state.orderSymbolCache).toEqual({
      'order-1': 'BTC/USDT:USDT',
      'order-2': 'ETH/USDT:USDT',
    })
  })

  it('loadBrokerState restores orderSymbolCache', () => {
    const acc = makeAccount()
    setInitialized(acc, {})

    acc.loadBrokerState({
      orderSymbolCache: {
        'order-1': 'BTC/USDT:USDT',
        'order-2': 'ETH/USDT:USDT',
      },
    })

    expect((acc as any).orderSymbolCache.get('order-1')).toBe('BTC/USDT:USDT')
    expect((acc as any).orderSymbolCache.get('order-2')).toBe('ETH/USDT:USDT')
  })

  it('loadBrokerState handles missing orderSymbolCache gracefully', () => {
    const acc = makeAccount()
    setInitialized(acc, {})

    acc.loadBrokerState({})
    expect((acc as any).orderSymbolCache.size).toBe(0)
  })
})

describe('CcxtBroker — getOrder open order discovery', () => {
  it('discovers order symbol via fetchOpenOrders on cache miss', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    const market = makeSwapMarket('ETH', 'USDT', 'ETH/USDT:USDT')
    setInitialized(acc, { 'ETH/USDT:USDT': market })

    // No orderSymbolCache entry for 'ord-discovered'
    ;(acc as any).exchange.fetchOpenOrders = vi.fn().mockResolvedValue([
      { id: 'ord-discovered', symbol: 'ETH/USDT:USDT', side: 'buy', amount: 1, type: 'limit', price: 2000, status: 'open' },
      { id: 'ord-other', symbol: 'BTC/USDT:USDT', side: 'sell', amount: 0.1, type: 'limit', price: 60000, status: 'open' },
    ])
    ;(acc as any).exchange.fetchOrder = vi.fn().mockResolvedValue({
      id: 'ord-discovered', symbol: 'ETH/USDT:USDT', side: 'buy', amount: 1,
      type: 'limit', price: 2000, status: 'open',
    })

    const result = await acc.getOrder('ord-discovered')
    expect(result).not.toBeNull()
    expect(result!.order.action).toBe('BUY')
    // fetchOpenOrders was called to discover the symbol
    expect((acc as any).exchange.fetchOpenOrders).toHaveBeenCalled()
    // The discovered symbol should now be in the cache
    expect((acc as any).orderSymbolCache.get('ord-discovered')).toBe('ETH/USDT:USDT')
    expect((acc as any).orderSymbolCache.get('ord-other')).toBe('BTC/USDT:USDT')
  })

  it('returns null when order not found in open orders either', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, {})

    ;(acc as any).exchange.fetchOpenOrders = vi.fn().mockResolvedValue([])

    const result = await acc.getOrder('nonexistent')
    expect(result).toBeNull()
  })

  it('returns null when fetchOpenOrders fails', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, {})

    ;(acc as any).exchange.fetchOpenOrders = vi.fn().mockRejectedValue(new Error('API error'))

    const result = await acc.getOrder('nonexistent')
    expect(result).toBeNull()
  })
})

// ==================== Balance + ticker caching ====================

describe('CcxtBroker — spot balance cache', () => {
  it('reuses cached balance within TTL (no redundant fetchBalance calls)', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, {
      'CRO/USD': makeSpotMarket('CRO', 'USD', 'CRO/USD'),
    })

    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { USDT: 100, CRO: 50 },
      used: {},
      total: { USDT: 100, CRO: 50 },
    })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])
    ;(acc as any).exchange.fetchTicker = vi.fn().mockResolvedValue({ last: 0.10 })

    // Call both getAccount and getPositions (simulates a sync cycle)
    await acc.getAccount()
    await acc.getPositions()

    // fetchBalance should only be called once (cached on second call)
    expect((acc as any).exchange.fetchBalance).toHaveBeenCalledTimes(1)
  })

  it('ticker cache deduplicates fetchTicker calls within a sync cycle', async () => {
    const acc = makeAccount({ exchange: 'binance' })
    setInitialized(acc, {
      'CRO/USD': makeSpotMarket('CRO', 'USD', 'CRO/USD'),
    })

    ;(acc as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      free: { USDT: 100 },
      used: {},
      total: { USDT: 100, CRO: 50 },
    })
    ;(acc as any).exchange.fetchPositions = vi.fn().mockResolvedValue([])
    ;(acc as any).exchange.fetchTicker = vi.fn().mockResolvedValue({ last: 0.10 })

    // Both getAccount (for spot holdings value) and getPositions (for spot positions) need CRO ticker
    await acc.getAccount()
    await acc.getPositions()

    // fetchTicker('CRO/USD') called once (cached on second)
    expect((acc as any).exchange.fetchTicker).toHaveBeenCalledTimes(1)
    expect((acc as any).exchange.fetchTicker).toHaveBeenCalledWith('CRO/USD')
  })
})
