import type { PublicConfig } from '@yoda/shared'
import type { BootError } from '~/utils/publicConfig'
import { publicValues } from '~/utils/publicConfig'

/**
 * Core's `/public-config`, read by the boot plugin before the app mounts (null when it could not be read), the
 * boot error the app shows instead of its pages, and the shell's values (a non-empty NUXT_PUBLIC_* still wins).
 */
export function usePublicConfig() {
  const config = useState<PublicConfig | null>('publicConfig', () => null)
  const bootError = useState<BootError | null>('bootError', () => null)
  const values = () => publicValues(useRuntimeConfig().public, config.value)
  return { config, bootError, values }
}
