import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { deleteDraft, deleteDraftsOf, getDraft, listDrafts, newDraft, purgeOldDrafts, putDraft } from '../src/drafts/db'

const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' })

beforeEach(async () => {
  for (const d of await listDrafts()) await deleteDraft(d.id)
})

describe('drafts', () => {
  it('a draft survives a reload and keeps its idempotency key', async () => {
    const d = newDraft({ profileId: 'p1', tabId: 3, tabUrl: 'https://app.example.org/opd' })
    d.images.push({ role: 'screenshot', blob: png() })
    await putDraft(d)
    const back = await getDraft(d.id)
    expect(back!.idempotencyKey).toBe(d.idempotencyKey)
    expect(back!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(back!.images[0]!.role).toBe('screenshot')
    expect(new Uint8Array(await back!.images[0]!.blob.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 1, 2, 3]))
    // A later save keeps the key.
    await putDraft({ ...back!, form: { title: 'x' } })
    expect((await getDraft(d.id))!.idempotencyKey).toBe(d.idempotencyKey)
  })

  it('drafts older than 24 h are purged', async () => {
    const old = { ...newDraft({ profileId: 'p1', tabId: 1, tabUrl: 'https://a.example.org/' }), createdAt: Date.now() - 25 * 3600_000 }
    const fresh = newDraft({ profileId: 'p1', tabId: 2, tabUrl: 'https://a.example.org/' })
    await putDraft(old)
    await putDraft(fresh)
    expect(await purgeOldDrafts(Date.now())).toBe(1)
    expect((await listDrafts()).map((d) => d.id)).toEqual([fresh.id])
  })

  it("deleteDraftsOf removes one profile's drafts only", async () => {
    const mine = newDraft({ profileId: 'p1', tabId: 1, tabUrl: 'https://a.example.org/' })
    const other = newDraft({ profileId: 'p2', tabId: 2, tabUrl: 'https://a.example.org/' })
    await putDraft(mine)
    await putDraft(other)
    expect(await deleteDraftsOf('p1')).toBe(1)
    expect((await listDrafts()).map((d) => d.id)).toEqual([other.id])
  })

  it('deleteDraft removes the images', async () => {
    const d = newDraft({ profileId: 'p1', tabId: 3, tabUrl: 'https://a.example.org/' })
    d.images.push({ role: 'screenshot', blob: png() })
    await putDraft(d)
    await deleteDraft(d.id)
    expect(await getDraft(d.id)).toBeNull()
    expect(await listDrafts()).toEqual([])
  })
})
