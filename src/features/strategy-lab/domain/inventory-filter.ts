import type {
  Inventory,
  InventoryStrategy,
} from '../infrastructure/strategy-api.ts'

export type InventoryFilter =
  'all' | 'active' | 'frozen' | 'closed' | 'investigating' | 'edge'

export const FILTERS: readonly { id: InventoryFilter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'active', label: 'Activas' },
  { id: 'frozen', label: 'Congeladas' },
  { id: 'closed', label: 'Cerradas' },
  { id: 'investigating', label: 'En investigación' },
  { id: 'edge', label: 'Evidencia preliminar' },
]

export function filterCount(inventory: Inventory, filter: InventoryFilter) {
  const { counts } = inventory
  return {
    all: inventory.strategies.length,
    active: counts.active,
    frozen: counts.frozen,
    closed: counts.closed,
    investigating: counts.investigating,
    edge: counts.edge_evidence,
  }[filter]
}

export function matchesFilter(
  row: InventoryStrategy,
  filter: InventoryFilter,
): boolean {
  switch (filter) {
    case 'active':
      return row.operational.state === 'active' && row.kind !== 'carry'
    case 'frozen':
      return row.frozen
    case 'closed':
      return row.operational.state === 'closed'
    case 'investigating':
      return row.research.investigating
    case 'edge':
      return row.research.evidence_of_edge
    default:
      return true
  }
}
