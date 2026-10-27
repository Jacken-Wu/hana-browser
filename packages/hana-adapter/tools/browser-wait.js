import { runTool } from '../lib/bridge-core.js'

export const name = 'browser_wait'

export const description =
  'Wait for loading and DOM changes to settle, with an optional extra delay.'

export const parameters = {
  type: 'object',
  properties: {
    ms: { type: 'number', description: 'Additional milliseconds to wait. Omit to perform only the settle check.' },
    frame: { type: 'number', description: 'Iframe number from browser_snapshot; omit for the top page.' },
  },
}

export async function execute(input = {}) {
  const args = {}
  if (input.ms !== undefined) args.ms = input.ms
  if (input.frame !== undefined) args.frame = input.frame
  return runTool('browser_wait', args)
}
