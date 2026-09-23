import { useEffect, useState } from 'react'

type Status = { enabled: boolean; apiKeyConfigured: boolean }

export default function GeminiControl({
  onEnabledChange,
}: {
  onEnabledChange: (enabled: boolean) => void
}) {
  const [status, setStatus] = useState<Status>({
    enabled: false,
    apiKeyConfigured: false,
  })
  const [ready, setReady] = useState(false)
  const baseUrl =
    import.meta.env.VITE_GEMINI_SERVER_URL ?? 'http://127.0.0.1:8787'

  useEffect(() => {
    let active = true
    void fetch(`${baseUrl}/api/gemini/status`)
      .then((response) => response.json() as Promise<Status>)
      .then((next) => {
        if (!active) return
        setStatus(next)
        setReady(true)
        onEnabledChange(next.enabled)
      })
      .catch(() => {
        if (active) setReady(true)
      })
    return () => {
      active = false
    }
  }, [baseUrl, onEnabledChange])

  async function toggle() {
    const response = await fetch(`${baseUrl}/api/gemini/status`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !status.enabled }),
    })
    if (!response.ok) return
    const next = (await response.json()) as Status
    setStatus(next)
    onEnabledChange(next.enabled)
  }

  return (
    <section className="app__ai-toggle" aria-label="Control global de Gemini">
      <span className="app__ai-toggle-label">Llamadas a Gemini</span>
      <button
        type="button"
        role="switch"
        aria-label="Llamadas a Gemini"
        aria-checked={status.enabled}
        disabled={!ready || !status.apiKeyConfigured}
        className="app__ai-toggle-switch"
        onClick={() => void toggle()}
      >
        {status.enabled ? 'Activadas' : 'Desactivadas'}
      </button>
      <span role="status" className="app__ai-toggle-hint">
        {!ready
          ? 'Estado del servidor no disponible'
          : status.apiKeyConfigured
            ? 'Clave configurada en el servidor'
            : 'Clave no configurada'}
        {!status.enabled && ready ? ' · desactivadas al iniciar' : ''}
      </span>
    </section>
  )
}
