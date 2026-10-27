import { runTool } from '../lib/bridge-core.js'

export const name = 'browser_reload'

export const description = 'Reload the current page in the controlled tab.'

export const parameters = { type: 'object', properties: {} }

export async function execute() {
  return runTool('browser_reload', {})
}
