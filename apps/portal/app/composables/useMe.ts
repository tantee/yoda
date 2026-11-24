import type { Me } from '@yoda/shared'

export function useMe() {
  const me = useState<Me | null>('me', () => null)
  async function refresh() {
    me.value = await useApi()<Me>('/me')
  }
  return { me, refresh }
}
