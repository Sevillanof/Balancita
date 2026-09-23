export type AnalysisMode = 'local' | 'ai'

type AnalysisModeToggleProps = {
  mode: AnalysisMode
  disabled?: boolean
  onChange: (mode: AnalysisMode) => void
}

/**
 * Opt-in switch for the optional Gemini analysis gateway. Off by default: the
 * app is fully local and the toggle only changes which provider sits behind
 * the Analyze button. Toggling never triggers an analysis on its own.
 */
export function AnalysisModeToggle({
  mode,
  disabled = false,
  onChange,
}: AnalysisModeToggleProps) {
  const aiEnabled = mode === 'ai'
  const labelId = 'analysis-mode-toggle-label'
  return (
    <div className="app__ai-toggle">
      <span id={labelId} className="app__ai-toggle-label">
        Análisis con IA
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={aiEnabled}
        aria-labelledby={labelId}
        className="app__ai-toggle-switch"
        disabled={disabled}
        title={
          disabled
            ? 'El análisis con IA no está disponible porque no hay una puerta de enlace configurada.'
            : undefined
        }
        onClick={() => onChange(aiEnabled ? 'local' : 'ai')}
      >
        {aiEnabled ? 'Activado' : 'Desactivado'}
      </button>
      {disabled && <span className="app__ai-toggle-hint">No disponible</span>}
    </div>
  )
}
