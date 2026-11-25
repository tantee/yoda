import { loadConfig, maskedConfig, warnConfigOnce } from './config.js'

// Commands. Task 8 adds `work <taskId>`, `start` and `mcp-config`.
const USAGE = `Usage: yoda-runner <command>

Commands:
  config show    Print the runner config (the token is masked)
`

async function main(argv: string[]): Promise<number> {
  const [cmd, sub] = argv
  if (cmd === 'config' && sub === 'show') {
    const cfg = loadConfig()
    warnConfigOnce(cfg)
    process.stdout.write(`${JSON.stringify(maskedConfig(cfg), null, 2)}\n`)
    return 0
  }
  process.stderr.write(USAGE)
  return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  },
)
