// Chrome binary resolution. Order: explicit flag, CHROME_BIN, common paths.
import { existsSync } from 'node:fs'

const CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

export function resolveChrome(explicit) {
  const pick = explicit || process.env.CHROME_BIN
  if (pick) {
    if (!existsSync(pick)) throw new Error(`Chrome not found at ${pick}`)
    return pick
  }
  const found = CANDIDATES.find((c) => existsSync(c))
  if (!found) {
    throw new Error('No Chrome/Chromium found. Set CHROME_BIN or pass --chrome <path>.')
  }
  return found
}
