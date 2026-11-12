/** A small group of mutually exclusive buttons (the selector of the replay speed and of the candle interval). */
export default function Segmentado<T extends string>({
  nombre,
  opciones,
  valor,
  onElegir,
  relleno,
}: {
  nombre: string
  opciones: ReadonlyArray<{ id: T; texto: string }>
  valor: T
  onElegir: (id: T) => void
  relleno: 'info' | 'surface'
}) {
  return (
    <span
      role="group"
      aria-label={nombre}
      className="inline-flex rounded-control border border-solid border-line bg-surface-2 p-0.5"
    >
      {opciones.map(({ id, texto }) => (
        <button
          key={id}
          type="button"
          aria-pressed={valor === id}
          onClick={() => onElegir(id)}
          className={`h-5.5 cursor-pointer rounded-sm border-0 px-2.5 text-hint whitespace-nowrap ${
            relleno === 'surface' ? 'font-mono' : ''
          } ${
            valor !== id
              ? 'bg-transparent text-ink-2'
              : relleno === 'info'
                ? 'bg-info font-semibold text-canvas'
                : 'bg-line text-ink'
          }`}
        >
          {texto}
        </button>
      ))}
    </span>
  )
}
