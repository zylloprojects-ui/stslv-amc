import { api } from '../../lib/api'
import type { Client, Paged } from '../../lib/types'

/** Builds "?a=1&b=2", leaving out empty values. */
export function queryString(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value))
    }
  }

  const text = search.toString()

  return text ? `?${text}` : ''
}

/** Every client of the Client Master with the given status, for a selection list. */
export async function fetchClients(status: 'active' | 'all'): Promise<Client[]> {
  const clients: Client[] = []

  for (let page = 1; ; page += 1) {
    const result = await api.get<Paged<Client>>(`/clients${queryString({ status, page, pageSize: 100 })}`)

    clients.push(...result.items)

    if (result.items.length === 0 || clients.length >= result.total) {
      return clients
    }
  }
}
