import { useEffect, useState, type ReactNode } from 'react'

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
  return (product ?? 'PF_ETHUSD').replace(/^PF_/, '').replace(/USD$/, '')
}

/** Full-screen dark frame: the terminal is not rendered yet, so nothing else is on screen. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-canvas px-4 font-sans text-body text-ink font-features-terminal">
      <p className="flex items-center gap-2 text-brand-mark font-semibold tracking-wide text-ink">
        <span
          aria-hidden="true"
          className="size-2 animate-pulse rounded-full bg-long"
        />
        Balancita
      </p>
      <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-md border border-solid border-line bg-surface-1 px-8 py-9 text-center">
        {children}
      </div>
    </div>
  )
}

/** Ring with the product inside: spinning arc while loading, solid red when failed. */
function Ring({
  product,
  failed,
}: {
  product: string | undefined
  failed: boolean
}) {
  return (
    <div className="relative grid size-24 place-items-center">
      <span
        aria-hidden="true"
        className={`absolute inset-0 rounded-full border-4 border-solid ${failed ? 'border-short' : 'animate-spin border-line border-t-info'}`}
      />
      <span className="text-value font-semibold text-ink">
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
    <Frame>
      <main
        role="status"
        aria-busy="true"
        className="flex w-full flex-col items-center gap-5"
      >
        <Ring product={product} failed={false} />
        <div className="flex flex-col gap-1">
          <h1 className="text-value font-semibold">Cargando la Terminal</h1>
          <p className="text-note text-ink-2">
            Fuente: Real (paper, Kraken público) · {productLabel(product)}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2">
          <div
            aria-hidden="true"
            className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full rounded-full bg-info transition-[width] duration-300 ease-linear"
              style={{ width: `${Math.round(share * 100)}%` }}
            />
          </div>
          <p className="text-hint text-ink-2">
            Esperando respuesta del servidor · {seconds} s
          </p>
        </div>
        {elapsed >= slowMs ? (
          <p className="rounded-sm border border-solid border-warn px-3 py-2 text-note text-warn">
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
    <Frame>
      <main role="alert" className="flex w-full flex-col items-center gap-5">
        <Ring product={product} failed />
        <div className="flex flex-col gap-1">
          <h1 className="text-value font-semibold">
            Terminal de futuros no disponible
          </h1>
          <p className="text-note text-ink-2">
            No se pudo conectar con la fuente «Real (paper, Kraken público)». No
            se cambió a otra fuente automáticamente.
          </p>
        </div>
        <p className="w-full rounded-sm border border-solid border-line bg-surface-2 px-3 py-2 text-left text-note text-ink">
          Motivo: {reason}
        </p>
        <div className="flex flex-col items-center gap-2">
          <p className="text-hint text-ink-2">
            Reintentando automáticamente
            {wait > 0 ? ` en ${wait} s` : ' ahora'} · intento {attempts}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="min-h-8 rounded-sm border border-solid border-line-strong bg-surface-2 px-4 text-note text-ink hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-2"
          >
            Reintentar ahora
          </button>
        </div>
      </main>
    </Frame>
  )
}
