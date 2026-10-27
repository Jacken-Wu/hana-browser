import { runTool } from '../lib/bridge-core.js'

export const name = 'browser_forward'

export const description = 'Go forward to the next page in the controlled tab.'

export const parameters = { type: 'object', properties: {} }

export async function execute() {
  return runTool('browser_forward', {})
}
