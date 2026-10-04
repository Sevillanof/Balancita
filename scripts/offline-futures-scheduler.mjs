export function classifyReplayCompletion({ closeMessage, processed, total }) {
  const processingComplete =
    Number.isSafeInteger(processed) &&
    Number.isSafeInteger(total) &&
    processed === total
  const closed = closeMessage?.type === 'closed'
  const pending = closeMessage?.durable_pending_source_rows
  const knownPending = Number.isSafeInteger(pending) && pending >= 0
  let outcome = 'unknown_processing'

  if (knownPending && pending > 0) outcome = 'stopped_deferred'
  else if (
    knownPending &&
    pending === 0 &&
    Number.isSafeInteger(closeMessage.source_count) &&
    Number.isSafeInteger(closeMessage.source_watermark) &&
    closeMessage.source_watermark === closeMessage.source_count &&
    closeMessage.normal_close === true &&
    processingComplete &&
    closed
  )
    outcome = 'source_complete'

  return {
    outcome,
    processing_complete: processingComplete,
    closed,
    durable_pending_source_rows: knownPending ? pending : null,
    source_count: Number.isSafeInteger(closeMessage?.source_count)
      ? closeMessage.source_count
      : null,
    source_watermark: Number.isSafeInteger(closeMessage?.source_watermark)
      ? closeMessage.source_watermark
      : null,
  }
}

export function createReplayScheduler({
  rows,
  deliver,
  speed = 1,
  now = () => performance.now(),
}) {
  if (![0.5, 1, 2].includes(speed))
    throw new Error('Replay speed must be 0.5, 1, or 2.')
  let timer = null
  let cancelled = false
  let index = 0
  const started = now()
  const sourceStart = rows[0]?.received_at ?? 0

  const schedule = () => {
    if (cancelled || index >= rows.length) return
    const row = rows[index]
    const due = started + (row.received_at - sourceStart) / speed
    timer = setTimeout(
      () => {
        timer = null
        const actual = now()
        index += 1
        try {
          Promise.resolve(
            deliver(row, {
              index: index - 1,
              due,
              actual,
              latenessMs: Math.max(0, actual - due),
            }),
          ).catch(() => {})
        } catch {}
        schedule()
      },
      Math.max(0, due - now()),
    )
  }

  schedule()
  return {
    cancel() {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    get processed() {
      return index
    },
    get complete() {
      return index === rows.length
    },
  }
}
