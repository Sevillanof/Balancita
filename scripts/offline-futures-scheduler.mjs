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
