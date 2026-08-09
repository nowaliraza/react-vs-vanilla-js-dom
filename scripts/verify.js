// One command that has to pass before any number here is worth quoting.
//
// It exists because a nonzero exit code was ignored in this project once
// already: a run printed its whole results table, crashed on the way out, and
// the failure was waved through because the output looked complete. Each step
// below is checked on its exit status, not on whether it produced plausible
// text.
//
//   npm run verify
import { spawn } from 'node:child_process'

const STEPS = [
  {
    name: 'production build',
    cmd: 'npx',
    args: ['vite', 'build'],
    why: 'dev builds are several times slower and cannot be measured',
  },
  {
    name: 'fairness gate (22 scenarios, N=1000)',
    cmd: 'node',
    args: ['scripts/verify-fairness.js'],
    why: 'identical DOM everywhere, exact floors on matrix cells, every field compared',
  },
  {
    name: 'headless smoke (8 scenarios)',
    cmd: 'node',
    args: ['scripts/headless.js', '--rows', '100', '--iterations', '2', '--rotations', '1', '--repeat', '1'],
    why: 'the default runner actually completes and exits clean',
  },
]

function run({ cmd, args }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

let failed = 0
for (const step of STEPS) {
  process.stdout.write(`  ${step.name.padEnd(32)}`)
  const started = Date.now()
  const { code, out } = await run(step)
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  if (code === 0) {
    console.log(`ok    ${secs}s   ${step.why}`)
  } else {
    failed++
    console.log(`FAIL  ${secs}s   exit ${code}`)
    console.log(out.split('\n').slice(-25).map((l) => '      ' + l).join('\n'))
  }
}

console.log(failed === 0
  ? '\n  All checks passed.\n'
  : `\n  ${failed} check(s) failed.\n`)
process.exit(failed === 0 ? 0 : 1)
