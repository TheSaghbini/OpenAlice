import { Hono } from 'hono'
import { loadConfig, writeConfigSection, readAIProviderConfig, validSections, writeAIBackend, type ConfigSection, type AIBackend } from '../../../core/config.js'
import type { EngineContext } from '../../../core/types.js'

interface ConfigRouteOpts {
  onConnectorsChange?: () => Promise<void>
}

/** Config routes: GET /, PUT /ai-provider, PUT /:section, GET /api-keys/status */
export function createConfigRoutes(opts?: ConfigRouteOpts) {
  const app = new Hono()

  app.get('/', async (c) => {
    try {
      const config = await loadConfig()
      return c.json(config)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.put('/ai-provider', async (c) => {
    try {
      const body = await c.req.json<{ backend?: string }>()
      const backend = body.backend
      if (backend !== 'claude-code' && backend !== 'vercel-ai-sdk' && backend !== 'agent-sdk' && backend !== 'codex') {
        return c.json({ error: 'Invalid backend. Must be "claude-code", "vercel-ai-sdk", "agent-sdk", or "codex".' }, 400)
      }
      await writeAIBackend(backend as AIBackend)
      return c.json({ backend })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.put('/:section', async (c) => {
    try {
      const section = c.req.param('section') as ConfigSection
      if (!validSections.includes(section)) {
        return c.json({ error: `Invalid section "${section}". Valid: ${validSections.join(', ')}` }, 400)
      }
      const body = await c.req.json()
      const validated = await writeConfigSection(section, body)
      // Hot-reload connectors / OpenBB server when their config changes
      if (section === 'connectors' || section === 'marketData') {
        await opts?.onConnectorsChange?.()
      }
      return c.json(validated)
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        return c.json({ error: 'Validation failed', details: JSON.parse(err.message) }, 400)
      }
      return c.json({ error: String(err) }, 500)
    }
  })

  app.get('/api-keys/status', async (c) => {
    try {
      const config = await readAIProviderConfig()
      return c.json({
        anthropic: !!config.apiKeys.anthropic,
        openai: !!config.apiKeys.openai,
        google: !!config.apiKeys.google,
      })
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  return app
}

/** Market data routes: POST /test-provider */
export function createMarketDataRoutes(ctx: EngineContext) {
  const TEST_ENDPOINTS: Record<string, { credField: string; provider: string; model: string; params: Record<string, unknown> }> = {
    fred:             { credField: 'fred_api_key',             provider: 'fred',             model: 'FredSearch',              params: { query: 'GDP' } },
    bls:              { credField: 'bls_api_key',              provider: 'bls',              model: 'BlsSearch',               params: { query: 'unemployment' } },
    eia:              { credField: 'eia_api_key',              provider: 'eia',              model: 'ShortTermEnergyOutlook',  params: {} },
    econdb:           { credField: 'econdb_api_key',           provider: 'econdb',           model: 'AvailableIndicators',     params: {} },
    fmp:              { credField: 'fmp_api_key',              provider: 'fmp',              model: 'EquityScreener',          params: { limit: 1 } },
    nasdaq:           { credField: 'nasdaq_api_key',           provider: 'nasdaq',           model: 'EquitySearch',            params: { query: 'AAPL', is_symbol: true } },
    intrinio:         { credField: 'intrinio_api_key',         provider: 'intrinio',         model: 'EquitySearch',            params: { query: 'AAPL', limit: 1 } },
    tradingeconomics: { credField: 'tradingeconomics_api_key', provider: 'tradingeconomics', model: 'EconomicCalendar',        params: {} },
  }

  const app = new Hono()

  app.post('/test-provider', async (c) => {
    try {
      const { provider, key } = await c.req.json<{ provider: string; key: string }>()
      const endpoint = TEST_ENDPOINTS[provider]
      if (!endpoint) return c.json({ ok: false, error: `Unknown provider: ${provider}` }, 400)
      if (!key) return c.json({ ok: false, error: 'No API key provided' }, 400)

      const result = await ctx.bbEngine.execute(
        endpoint.provider, endpoint.model, endpoint.params,
        { [endpoint.credField]: key },
      )
      const data = result as unknown[]
      if (data && data.length > 0) return c.json({ ok: true })
      return c.json({ ok: false, error: 'API returned empty data — key may be invalid or endpoint restricted' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, error: msg })
    }
  })

  return app
}
