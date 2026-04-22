import { useParams } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import { SearchBox } from '../components/market/SearchBox'
import { EquityDetail } from './market/EquityDetail'
import { GenericDetail } from './market/GenericDetail'
import type { AssetClass } from '../api/market'

const KNOWN: ReadonlySet<AssetClass> = new Set(['equity', 'crypto', 'currency', 'commodity'])

export function MarketDetailPage() {
  const { assetClass, symbol } = useParams<{ assetClass: string; symbol: string }>()
  const ac = assetClass as AssetClass | undefined
  const validClass = ac && KNOWN.has(ac) ? ac : null

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="Market" description="Search assets and view price history." />
      <div className="flex-1 flex flex-col gap-3 px-4 md:px-8 py-4 min-h-0 overflow-y-auto">
        <SearchBox />
        {!validClass || !symbol ? (
          <div className="flex-1 flex items-center justify-center text-[13px] text-text-muted">
            Unknown asset class — search for a symbol above.
          </div>
        ) : validClass === 'equity' ? (
          <EquityDetail symbol={symbol} />
        ) : (
          <GenericDetail symbol={symbol} assetClass={validClass} />
        )}
      </div>
    </div>
  )
}
