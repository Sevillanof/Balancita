export function classifyReplayCompletion({ closeMessage, processed, total }) {
  const deliveryComplete =
    Number.isSafeInteger(processed) &&
    Number.isSafeInteger(total) &&
    processed === total
  const closed = closeMessage?.type === 'closed'
  const sourceQueue = closeMessage?.final_source_queue
  const eligiblePending = closeMessage?.durable_pending_source_rows
  const inspectionPolicyBound = sourceQueue?.inspection_policy_bound === true
  const inspectionMetadataExpected =
    inspectionPolicyBound ||
    (closeMessage?.source_inspection_contract ===
      'futures-source-inspection.v1' &&
      sourceQueue?.inspection_policy_bound !== false)
  const pending = inspectionMetadataExpected
    ? sourceQueue?.durable_source_backlog
    : Number.isSafeInteger(sourceQueue?.durable_source_backlog)
      ? sourceQueue.durable_source_backlog
      : eligiblePending
  const knownPending = Number.isSafeInteger(pending) && pending >= 0
  const normalizedCount = sourceQueue?.source_events_persisted
  const inspectedSeq = sourceQueue?.last_inspected_source_seq
  const sourceHeadSeq = sourceQueue?.source_received_seq
  const noActionRows = sourceQueue?.inspected_no_action_source_rows
  const financialRows = sourceQueue?.financial_source_coverage_rows
  const sourceCoverageRows = sourceQueue?.source_coverage_rows
  const closeResourcesVerified =
    closeMessage?.child_process_closed === true &&
    closeMessage?.app_resources_closed === true &&
    closeMessage?.worker_closed === true &&
    closeMessage?.child_exit_code === 0 &&
    closeMessage?.child_signal_code === null &&
    closeMessage?.forced_termination !== true
  const inspectionComplete =
    inspectionPolicyBound &&
    Number.isSafeInteger(normalizedCount) &&
    normalizedCount >= 0 &&
    Number.isSafeInteger(inspectedSeq) &&
    Number.isSafeInteger(sourceHeadSeq) &&
    inspectedSeq >= sourceHeadSeq &&
    knownPending &&
    pending === 0 &&
    Number.isSafeInteger(noActionRows) &&
    Number.isSafeInteger(financialRows) &&
    Number.isSafeInteger(sourceCoverageRows) &&
    sourceCoverageRows === normalizedCount
  const legacyProcessingComplete =
    !inspectionPolicyBound && deliveryComplete && knownPending && pending === 0
  const processingComplete = inspectionMetadataExpected
    ? inspectionComplete
    : legacyProcessingComplete
  let outcome = 'unknown_processing'

  if (knownPending && pending > 0) outcome = 'stopped_deferred'
  else if (processingComplete && closeMessage.normal_close === true && closed) {
    outcome = inspectionMetadataExpected
      ? closeResourcesVerified
        ? 'source_complete'
        : 'unknown_processing'
      : Number.isSafeInteger(closeMessage.source_count) &&
          Number.isSafeInteger(closeMessage.source_watermark) &&
          closeMessage.source_watermark === closeMessage.source_count
        ? 'source_complete'
        : 'unknown_processing'
  }

  return {
    outcome,
    processing_complete: processingComplete,
    closed,
    delivery_complete: deliveryComplete,
    durable_pending_source_rows: knownPending ? pending : null,
    eligible_pending_source_rows: Number.isSafeInteger(eligiblePending)
      ? eligiblePending
      : null,
    source_count: Number.isSafeInteger(closeMessage?.source_count)
      ? closeMessage.source_count
      : null,
    source_watermark: Number.isSafeInteger(
      inspectionPolicyBound
        ? sourceQueue?.source_watermark
        : closeMessage?.source_watermark,
    )
      ? inspectionPolicyBound
        ? sourceQueue.source_watermark
        : closeMessage.source_watermark
      : null,
    normalized_source_events_persisted: Number.isSafeInteger(normalizedCount)
      ? normalizedCount
      : null,
    last_inspected_source_seq: Number.isSafeInteger(inspectedSeq)
      ? inspectedSeq
      : null,
    source_received_seq: Number.isSafeInteger(sourceHeadSeq)
      ? sourceHeadSeq
      : null,
    last_financial_source_seq: Number.isSafeInteger(
      sourceQueue?.last_financial_source_seq,
    )
      ? sourceQueue.last_financial_source_seq
      : null,
    inspected_no_action_source_rows: Number.isSafeInteger(noActionRows)
      ? noActionRows
      : null,
    financial_source_coverage_rows: Number.isSafeInteger(financialRows)
      ? financialRows
      : null,
    source_coverage_rows: Number.isSafeInteger(sourceCoverageRows)
      ? sourceCoverageRows
      : null,
    source_coverage_unavailable_reason: Number.isSafeInteger(sourceCoverageRows)
      ? null
      : 'Financial receipt source-row count or inspected no-action audit count was unavailable.',
    inspection_completion_unavailable_reason: inspectionComplete
      ? null
      : inspectionMetadataExpected
        ? 'Inspection cursor, durable SQL backlog, or complete source coverage evidence is unavailable or incomplete.'
        : 'A policy-bound durable inspection cursor was unavailable; legacy financial watermark is not used as inspection progress.',
    source_queue_snapshot: sourceQueue ?? null,
  }
}

export function summarizeOfflineDiagnostics({ workerEvents, driverEvents }) {
  const workerAvailable = Array.isArray(workerEvents)
  const driverAvailable = Array.isArray(driverEvents)
  const sumUnique = (events, phase, field) => {
    if (!Array.isArray(events)) return null
    const seen = new Set()
    let total = 0
    for (const event of events) {
      if (
        event.phase !== phase ||
        typeof event.request_id !== 'string' ||
        !Number.isSafeInteger(event[field]) ||
        event[field] < 0
      )
        continue
      const key = `${event.request_id}:${phase}`
      if (seen.has(key)) continue
      seen.add(key)
      total += event[field]
    }
    return total
  }
  const financialReceipts = new Map()
  const financialSourceSequences = new Set()
  if (driverAvailable)
    for (const event of driverEvents) {
      if (
        event.phase !== 'receipt-materialize-hash' ||
        event.outcome !== 'end' ||
        typeof event.work_id !== 'string'
      )
        continue
      const identity = `${event.run_id}:${event.work_id}`
      financialReceipts.set(identity, event)
      if (Number.isSafeInteger(event.source_received_seq))
        financialSourceSequences.add(
          `${event.run_id}:${event.source_received_seq}`,
        )
    }
  const completedRequestIds = new Set(
    (workerEvents ?? [])
      .filter((event) => event.phase === 'stdin_write_callback')
      .map((event) => event.request_id)
      .filter((id) => typeof id === 'string'),
  )
  const serializedRequests = new Map()
  for (const event of workerEvents ?? [])
    if (
      event.phase === 'serialization_end' &&
      typeof event.request_id === 'string' &&
      Number.isSafeInteger(event.request_bytes)
    )
      serializedRequests.set(event.request_id, event.request_bytes)
  const requestsMissingWireSize = workerAvailable
    ? [...completedRequestIds].filter((id) => !serializedRequests.has(id))
        .length
    : null
  const requestWireBytes =
    workerAvailable && requestsMissingWireSize === 0
      ? [...completedRequestIds].reduce(
          (total, id) => total + serializedRequests.get(id),
          0,
        )
      : null
  const ackPayloadBytes = new Map()
  const completedAckRequestIds = workerAvailable ? new Set() : null
  for (const event of workerEvents ?? [])
    if (
      event.phase === 'ack_write_callback' &&
      typeof event.request_id === 'string'
    ) {
      completedAckRequestIds.add(event.request_id)
      if (Number.isSafeInteger(event.payload_bytes) && event.payload_bytes >= 0)
        ackPayloadBytes.set(event.request_id, event.payload_bytes)
    }
  const strategyWork = new Map()
  for (const event of workerEvents ?? [])
    if (
      event.phase === 'strategy_work' &&
      typeof event.request_id === 'string' &&
      typeof event.run_id === 'string' &&
      typeof event.work_id === 'string' &&
      Number.isSafeInteger(event.strategy_selection_cycles) &&
      event.strategy_selection_cycles >= 0 &&
      Number.isSafeInteger(event.strategy_evaluations) &&
      event.strategy_evaluations >= 0
    )
      strategyWork.set(event.request_id, event)
  const completeStrategyWork =
    workerAvailable &&
    completedRequestIds.size > 0 &&
    [...completedRequestIds].every((id) => strategyWork.has(id))
  const ackBytesComplete =
    workerAvailable &&
    completedAckRequestIds.size > 0 &&
    [...completedAckRequestIds].every((id) => ackPayloadBytes.has(id))
  const uniqueStrategyWork = new Map()
  for (const event of strategyWork.values())
    if (completedRequestIds.has(event.request_id))
      uniqueStrategyWork.set(`${event.run_id}:${event.work_id}`, event)
  return {
    ipc_request_wire_bytes: requestWireBytes,
    ipc_request_write_count: workerAvailable ? completedRequestIds.size : null,
    ipc_request_wire_bytes_unavailable_reason: !workerAvailable
      ? 'Worker trace was unavailable.'
      : requestsMissingWireSize > 0
        ? `${requestsMissingWireSize} completed request write(s) had no measured serialized wire-byte record.`
        : null,
    ipc_response_line_bytes: sumUnique(
      workerEvents,
      'frame_complete',
      'frame_bytes',
    ),
    ipc_response_line_count: workerAvailable
      ? new Set(
          workerEvents
            .filter((event) => event.phase === 'frame_complete')
            .map((event) => event.request_id)
            .filter((id) => typeof id === 'string'),
        ).size
      : null,
    ipc_ack_write_bytes: ackBytesComplete
      ? [...completedAckRequestIds].reduce(
          (total, id) => total + ackPayloadBytes.get(id),
          0,
        )
      : null,
    ipc_ack_write_count: completedAckRequestIds?.size ?? null,
    ipc_ack_bytes_unavailable_reason: !workerAvailable
      ? 'Worker trace was unavailable.'
      : ackBytesComplete
        ? null
        : 'One or more completed ACK writes have no measured payload byte length.',
    financial_work_count: driverAvailable ? financialReceipts.size : null,
    financial_source_coverage_rows: driverAvailable
      ? financialSourceSequences.size
      : null,
    confirmed_full_cycle_analysis_count: completeStrategyWork
      ? [...uniqueStrategyWork.values()].reduce(
          (total, event) => total + event.strategy_selection_cycles,
          0,
        )
      : null,
    strategy_evaluation_count: completeStrategyWork
      ? [...uniqueStrategyWork.values()].reduce(
          (total, event) => total + event.strategy_evaluations,
          0,
        )
      : null,
    analysis_count_unavailable_reason: !workerAvailable
      ? 'Worker trace was unavailable.'
      : completeStrategyWork
        ? null
        : 'One or more completed works have no measured strategy counters; financial work is not equated with analyses.',
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
