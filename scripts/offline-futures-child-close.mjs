export async function closeOfflineChild({
  app,
  closePhasesTracePath,
  workerTracePath,
  closeSourceState,
  readTraceEvents,
  readLastTraceEvent,
  sourceQueueTracePath,
  send,
  disconnect,
}) {
  await app?.close()
  const closeEvents = readTraceEvents(closePhasesTracePath)
  const workerEvents = readTraceEvents(workerTracePath)
  const openResources = new Map()
  for (const event of closeEvents ?? []) {
    const key = `${event.phase}:${event.resource_id ?? ''}`
    if (event.state === 'begin' || event.state === 'error')
      openResources.set(key, event)
    else if (event.state === 'end') openResources.delete(key)
  }
  send({
    type: 'closed',
    normal_close: true,
    source_inspection_contract: 'futures-source-inspection.v1',
    ...closeSourceState,
    final_source_queue: readLastTraceEvent(sourceQueueTracePath),
    app_resources_closed:
      closeEvents !== null &&
      closeEvents.length > 0 &&
      openResources.size === 0,
    worker_closed:
      workerEvents?.some((event) => event.phase === 'closed') ?? false,
  })
  disconnect()
}
