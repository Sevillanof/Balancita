import { entryStateLabel } from './terminal-labels.ts'

export default function SimulatedControls({
  localDemo,
  gatewayEngine,
  entryRisk,
  connected,
  commandPending,
  commandStatus,
  confirmingReset,
  setConfirmingReset,
  sendCommand,
}: {
  localDemo: boolean
  gatewayEngine: boolean
  entryRisk: Record<string, unknown>
  connected: boolean
  commandPending: boolean
  commandStatus: string
  confirmingReset: boolean
  setConfirmingReset: (value: boolean) => void
  sendCommand: (action: string) => void
}) {
  return (
    <section className="connected-terminal__panel" aria-label="Controles paper">
      <h2>Controles simulados</h2>
      {localDemo && (
        <>
          <p>
            Pausar entradas bloquea solo nuevas entradas en esta ejecución MOCK;
            no detiene el motor, el mercado simulado, la protección ni los
            cierres.
          </p>
          <p>{entryStateLabel(entryRisk)}</p>
        </>
      )}
      {gatewayEngine && (
        <p>
          Pausar, reanudar y cerrar llegarán en PS-06: por ahora el terminal
          live es de solo lectura.
        </p>
      )}
      {(localDemo
        ? (['paper.pause', 'paper.resume', 'paper.new_run'] as const)
        : gatewayEngine
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
              (localDemo
                ? {
                    'paper.start': 'Iniciar simulación',
                    'paper.pause': 'Pausar entradas (MOCK)',
                    'paper.resume': 'Reanudar entradas (MOCK)',
                    'paper.close': 'Cerrar posición',
                    'paper.new_run': 'Nueva cuenta/run (MOCK)',
                  }
                : {
                    'paper.start': 'Iniciar simulación',
                    'paper.pause': 'Pausar entradas',
                    'paper.resume': 'Reanudar entradas',
                    'paper.close': 'Cerrar posición',
                    'paper.new_run': 'Nueva cuenta/run',
                  })[action]
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
              {localDemo
                ? 'Se crea una cuenta/run MOCK nueva que repite el escenario; el historial anterior se conserva.'
                : 'Se crea una cuenta/run nuevo; el historial anterior se conserva.'}
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
              {localDemo ? 'Nueva cuenta/run (MOCK)' : 'Nueva cuenta/run'}
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
