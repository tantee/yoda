import { EventEmitter } from 'node:events'
import type { LiveEvent } from '@yoda/shared'

export class LiveBus {
  private readonly emitter = new EventEmitter().setMaxListeners(0)

  publish(e: LiveEvent): void {
    for (const fn of this.emitter.listeners('event') as ((e: LiveEvent) => unknown)[]) {
      try {
        const r = fn(e)
        if (r && typeof (r as Promise<unknown>).catch === 'function') {
          ;(r as Promise<unknown>).catch((err) => console.error('live bus listener failed', err))
        }
      } catch (err) {
        console.error('live bus listener failed', err)
      }
    }
  }

  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.emitter.on('event', fn)
    return () => void this.emitter.off('event', fn)
  }
}
