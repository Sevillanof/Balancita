export default function SimulatedControls({
  gatewayEngine,
  connected,
  commandPending,
  commandStatus,
  confirmingReset,
  setConfirmingReset,
  sendCommand,
  runId,
}: {
  gatewayEngine: boolean
  connected: boolean
  commandPending: boolean
  commandStatus: string
  confirmingReset: boolean
  setConfirmingReset: (value: boolean) => void
  sendCommand: (action: string) => void
  /** Run the controls act on, as the stream reports it. */
  runId?: string | null
}) {
  return (
    <section
      className="connected-terminal__panel"
      aria-label="Herramientas de simulación"
    >
      <h2>Herramientas de simulación</h2>
      <p>
        Actúan solo sobre el run {runId ? <code>{runId}</code> : 'activo'}; no
        controlan los experimentos forward.
      </p>
      {gatewayEngine && (
        <p>
          Pausar, reanudar y cerrar llegarán en PS-06: por ahora el terminal
          live es de solo lectura.
        </p>
      )}
      {(gatewayEngine
        ? (['paper.pause', 'paper.resume', 'paper.close'] as const)
        : ([
            'paper.start',
            'paper.pause',
            'paper.resume',
            'paper.close',
            'paper.new_run',
          ] as const)
      )
        .filter((action) => action !== 'paper.new_run')
        .map((action) => (
          <button
            key={action}
            type="button"
            className="demo-terminal__present"
            disabled={gatewayEngine || !connected || commandPending}
            onClick={() => {
              if (action === 'paper.new_run') {
                setConfirmingReset(true)
                return
              }
              sendCommand(action)
            }}
          >
            {
              {
                'paper.start': 'Iniciar simulación',
                'paper.pause': 'Pausar entradas',
                'paper.resume': 'Reanudar entradas',
                'paper.close': 'Cerrar posición',
                'paper.new_run': 'Nueva cuenta/run',
              }[action]
            }
          </button>
        ))}
      <div
        className="connected-terminal__reset"
        role="group"
        aria-label="Reiniciar cuenta"
      >
        {confirmingReset ? (
          <>
            <p role="alert">
              Se crea una cuenta/run nuevo; el historial anterior se conserva.
            </p>
            <button
              type="button"
              className="demo-terminal__present"
              disabled={!connected || commandPending}
              onClick={() => {
                setConfirmingReset(false)
                sendCommand('paper.new_run')
              }}
            >
              Confirmar nueva cuenta
            </button>
            <button
              type="button"
              className="demo-terminal__present"
              onClick={() => setConfirmingReset(false)}
            >
              Cancelar
            </button>
          </>
        ) : (
          !gatewayEngine && (
            <button
              type="button"
              className="demo-terminal__present"
              disabled={!connected || commandPending}
              onClick={() => setConfirmingReset(true)}
            >
              Nueva cuenta/run
            </button>
          )
        )}
      </div>
      {commandPending && (
        <span role="status">
          Comando enviado; aceptación no significa fill.
        </span>
      )}
      {commandStatus && <p role="status">{commandStatus}</p>}
    </section>
  )
}
