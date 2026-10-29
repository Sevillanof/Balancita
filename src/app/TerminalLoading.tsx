import { useEffect, useState, type ReactNode } from 'react'
import { productName } from '../features/trading-view/domain/product-label.ts'

/** Seconds elapsed since mount, refreshed four times a second. */
function useElapsedMs(): number {
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(startedAt)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  return now - startedAt
}

function productLabel(product: string | undefined): string {
  return productName(product)
}

const SOURCE = 'Real\u00a0(paper,\u00a0Kraken\u00a0público)'

/** Full-screen dark frame; the card and the logo sit in the same place in every state. */
function Frame({
  accent,
  children,
}: {
  accent: 'info' | 'short'
  children: ReactNode
}) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-canvas px-4 py-8 font-sans text-ink font-features-terminal">
      <div
        className={`flex h-190 w-full max-w-160 flex-col items-center gap-4 rounded-lg border border-solid bg-surface-1 px-8 py-10 text-center sm:px-16 ${accent === 'short' ? 'border-short' : 'border-line-focus'}`}
      >
        <p className="flex items-center gap-3 text-run-title leading-8 font-semibold tracking-wide">
          <span
            aria-hidden="true"
            className="size-3 animate-pulse rounded-full bg-long"
          />
          Balancita
        </p>
        {children}
      </div>
    </div>
  )
}

/** Big ring: spinning arc with the product inside while loading, solid red "!" when failed. */
function Ring({
  product,
  failed,
}: {
  product: string | undefined
  failed: boolean
}) {
  return (
    <div className="relative grid size-32 shrink-0 place-items-center">
      <span
        aria-hidden="true"
        className={`absolute inset-0 rounded-full border-4 border-solid ${failed ? 'border-short' : 'animate-spin border-line-strong border-t-info'}`}
      />
      <span
        className={`font-semibold ${failed ? 'text-splash-icon leading-none text-short' : 'text-run-value leading-none text-ink'}`}
      >
        {failed ? '!' : productLabel(product)}
      </span>
    </div>
  )
}

export function TerminalLoading({
  product,
  timeoutMs,
  slowMs,
}: {
  product: string | undefined
  timeoutMs: number
  slowMs: number
}) {
  const elapsed = useElapsedMs()
  const seconds = Math.floor(elapsed / 1000)
  const share = Math.min(1, elapsed / timeoutMs)
  return (
    <Frame accent="info">
      <main
        role="status"
        aria-busy="true"
        className="flex w-full flex-1 flex-col items-center justify-center gap-5"
      >
        <Ring product={product} failed={false} />
        <div className="flex flex-col gap-2">
          <h1 className="text-run-value leading-9 font-semibold text-balance">
            Cargando la Terminal
          </h1>
          <p className="text-brand-mark leading-7 text-ink">
            Fuente: {SOURCE} · {productLabel(product)}
          </p>
        </div>
        <div className="flex w-full max-w-md flex-col gap-3">
          <div
            aria-hidden="true"
            className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full rounded-full bg-info transition-all duration-300 ease-linear"
              style={{ width: `${Math.round(share * 100)}%` }}
            />
          </div>
          <p className="text-section leading-6 text-ink">
            Esperando respuesta del servidor · {seconds}&nbsp;s
          </p>
        </div>
        {elapsed >= slowMs ? (
          <p className="max-w-md rounded-lg border border-solid border-warn px-4 py-3 text-section leading-6 text-pretty text-warn">
            Está tardando más de lo normal: el servidor puede estar arrancando o
            muy ocupado. Se sigue intentando.
          </p>
        ) : null}
      </main>
    </Frame>
  )
}

export function TerminalUnavailable({
  product,
  reason,
  retryAtMs,
  attempts,
  onRetry,
}: {
  product: string | undefined
  reason: string
  retryAtMs: number
  attempts: number
  onRetry: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  const wait = Math.max(0, Math.ceil((retryAtMs - now) / 1000))
  return (
    <Frame accent="short">
      <main
        role="alert"
        className="flex w-full flex-1 flex-col items-center justify-center gap-5"
      >
        <Ring product={product} failed />
        <div className="flex flex-col gap-2">
          <h1 className="text-run-value leading-9 font-semibold text-balance">
            Terminal de futuros no disponible
          </h1>
          <p className="text-brand-mark leading-7 text-pretty text-ink">
            No se pudo conectar con la fuente de datos.
            <br />
            Fuente: {SOURCE}
          </p>
        </div>
        <p className="w-full max-w-md rounded-lg border border-solid border-line-strong bg-surface-2 px-4 py-3 text-title leading-6 text-pretty text-ink">
          Motivo: {reason}
        </p>
        <div className="flex flex-col items-center gap-4">
          <button
            type="button"
            onClick={onRetry}
            className="min-h-12 rounded-lg border-0 bg-info px-10 text-brand-compact font-semibold text-canvas hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
          >
            Reintentar ahora
          </button>
          <p className="text-section leading-6 text-ink">
            Reintento automático
            {wait > 0 ? ` en ${wait}\u00a0s` : ' ahora'} · intento {attempts}
          </p>
        </div>
      </main>
    </Frame>
  )
}
