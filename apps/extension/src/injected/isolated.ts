// ISOLATED world, injected on click only: the metadata reader and the bridge for the MAIN-world capture. The
// worker sets `__yodaNonce` in this world before injecting this file.
import { installBridge } from '../capture/bridge'
import { collectMetadata } from '../capture/metadata'

const w = window as unknown as { __yodaNonce?: string; __yodaCollect?: typeof collectMetadata }
if (w.__yodaNonce) installBridge(w.__yodaNonce)
w.__yodaCollect = collectMetadata
