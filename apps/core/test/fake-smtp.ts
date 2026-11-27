import { createServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'

/**
 * A tiny plain-text SMTP server for the settings test: greeting, EHLO, AUTH PLAIN / LOGIN against one
 * placeholder account, MAIL / RCPT / DATA, QUIT. No TLS (the test connects with `secure: false` and no STARTTLS).
 */
export class FakeSmtp {
  private server: Server | null = null
  readonly messages: { from: string; to: string[]; data: string }[] = []
  /** Base64 of `\0user\0pass` the server accepts; null = no auth offered. */
  constructor(private readonly account: { user: string; pass: string } | null = null) {}
  port = 0

  async start(): Promise<void> {
    this.server = createServer((socket) => this.session(socket))
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
    this.port = (this.server.address() as AddressInfo).port
  }

  private session(socket: Socket): void {
    const say = (line: string) => socket.write(`${line}\r\n`)
    let buf = ''
    let mode: 'cmd' | 'data' | 'login-user' | 'login-pass' = 'cmd'
    let from = ''
    let to: string[] = []
    let data: string[] = []
    let loginUser = ''
    const ok = (user: string, pass: string) => this.account !== null && user === this.account.user && pass === this.account.pass
    say('220 fake.example.org ESMTP')
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (mode === 'data') {
          if (line === '.') {
            this.messages.push({ from, to, data: data.join('\n') })
            mode = 'cmd'
            say('250 OK queued')
          } else data.push(line)
          continue
        }
        if (mode === 'login-user') {
          loginUser = Buffer.from(line, 'base64').toString()
          mode = 'login-pass'
          say('334 UGFzc3dvcmQ6')
          continue
        }
        if (mode === 'login-pass') {
          mode = 'cmd'
          say(ok(loginUser, Buffer.from(line, 'base64').toString()) ? '235 Authentication successful' : '535 Authentication failed')
          continue
        }
        const [verb, ...rest] = line.split(' ')
        const arg = rest.join(' ')
        switch (verb?.toUpperCase()) {
          case 'EHLO':
            say('250-fake.example.org')
            say(this.account ? '250-AUTH PLAIN LOGIN' : '250-8BITMIME')
            say('250 OK')
            break
          case 'HELO':
            say('250 fake.example.org')
            break
          case 'AUTH': {
            const [mech, initial] = arg.split(' ')
            if (mech?.toUpperCase() === 'PLAIN') {
              const [, user, pass] = Buffer.from(initial ?? '', 'base64').toString().split('\0')
              say(ok(user ?? '', pass ?? '') ? '235 Authentication successful' : '535 Authentication failed')
            } else if (mech?.toUpperCase() === 'LOGIN') {
              mode = 'login-user'
              say('334 VXNlcm5hbWU6')
            } else say('504 Unrecognized authentication type')
            break
          }
          case 'MAIL':
            from = arg
            to = []
            data = []
            say('250 OK')
            break
          case 'RCPT':
            to.push(arg)
            say('250 OK')
            break
          case 'DATA':
            mode = 'data'
            say('354 End data with <CR><LF>.<CR><LF>')
            break
          case 'RSET':
          case 'NOOP':
            say('250 OK')
            break
          case 'QUIT':
            say('221 Bye')
            socket.end()
            break
          default:
            say('502 Command not implemented')
        }
      }
    })
    socket.on('error', () => {})
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
  }
}
