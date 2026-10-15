import { useEffect, useState } from 'react'
import DecisionsPage from '../features/observability/presentation/DecisionsPage.tsx'
import {
  loadTerminalBootstrap,
  terminalApiBase,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { AppShell, DataState } from '../shared/mission-control/index.ts'
import { appNavigation } from './app-navigation.ts'
import AppStatusChips from './AppStatusChips.tsx'

/** `?product=PF_XBTUSD&bucket=1790000000000`: what a link to a verdict carries. */
function investigationTarget(search: string): {
  product: string | null
  bucket: number | null
} {
  const params = new URLSearchParams(search)
  const bucket = params.get('bucket')
  return {
    product: params.get('product'),
    bucket:
      bucket !== null && /^\d{1,15}$/.test(bucket) ? Number(bucket) : null,
  }
}

type Products =
  | { state: 'loading' }
  | { state: 'ready'; products: string[] }
  | { state: 'failed' }

/**
 * Investigación de decisiones: reached from the HISTORIAL of the Terminal (no
 * tab of its own), so the Terminal stays the current page of the navigation.
 */
export default function InvestigationPage() {
  const apiBase = terminalApiBase('live')
  const target = investigationTarget(window.location.search)
  const [products, setProducts] = useState<Products>({ state: 'loading' })
  useEffect(() => {
    let active = true
    loadTerminalBootstrap(apiBase)
      .then((bootstrap) => {
        if (active)
          setProducts({ state: 'ready', products: bootstrap.products ?? [] })
      })
      .catch(() => {
        if (active) setProducts({ state: 'failed' })
      })
    return () => {
      active = false
    }
  }, [apiBase])
  const list = products.state === 'ready' ? products.products : []
  const initial = target.product ?? list[0] ?? null
  return (
    <AppShell
      brandHref="/terminal"
      brandLabel="Balancita, ir a la terminal"
      navigation={appNavigation('terminal')}
      status={<AppStatusChips apiBase={apiBase} />}
    >
      {products.state === 'loading' && target.product === null ? (
        <DataState kind="loading" />
      ) : initial === null ? (
        <DataState
          kind="unavailable"
          title="Sin producto para investigar"
          detail="No se pudo leer la lista de productos del gateway y la dirección no indica ninguno (?product=PF_XBTUSD)."
        />
      ) : (
        <DecisionsPage
          key={products.state}
          products={list}
          initialProduct={initial}
          initialBucket={target.bucket}
        />
      )}
    </AppShell>
  )
}
