type Notice = { key: string; tone?: string; text: string }

const BORDER_CLASSES: Record<string, string> = {
  ok: 'border-long',
  warn: 'border-warn',
  bad: 'border-short',
}

export default function TerminalNotices({
  items,
  label,
  compact = false,
}: {
  items: Notice[]
  label?: string
  compact?: boolean
}) {
  return (
    <ul
      className={`flex flex-wrap gap-2 p-0 list-none ${compact ? 'm-0 text-hint' : 'mt-0 mr-0 mb-2 ml-0'}`}
      aria-label={label}
    >
      {items.map((item) => (
        <li
          className={`rounded-full border border-solid px-2.5 py-0.5 ${BORDER_CLASSES[item.tone ?? ''] ?? 'border-line'}`}
          key={item.key}
          data-tone={item.tone}
        >
          {item.text}
        </li>
      ))}
    </ul>
  )
}
