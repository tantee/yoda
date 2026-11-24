import type { FastifyInstance } from 'fastify'
import { buildApp, type AppDeps } from '../src/app.js'
import { signToken } from './jwt.js'
import { testDeps } from './helpers.js'

export async function makeApp(overrides: Partial<AppDeps> = {}): Promise<FastifyInstance> {
  const deps = await testDeps(overrides)
  return buildApp({ ...deps, config: { ...deps.config, bootstrapAdmins: ['boss'] } })
}

export type Who = { token: string; id: string }

/** Signs in (creating the person via /me). `staff` puts the user in the staff group. */
export async function login(
  app: FastifyInstance,
  username: string,
  opts: { staff?: boolean; name?: string } = {},
): Promise<Who> {
  const token = await signToken({
    sub: `sub-${username}`,
    preferred_username: username,
    name: opts.name ?? username,
    groups: opts.staff ? ['/it-dev'] : [],
  })
  const res = await app.inject({ url: '/me', headers: { authorization: `Bearer ${token}` } })
  return { token, id: res.json().id }
}

export const auth = (w: Who) => ({ authorization: `Bearer ${w.token}` })
