import { runTool } from '../lib/bridge-core.js'

export const name = 'browser_back'

export const description = 'Go back to the previous page in the controlled tab.'

export const parameters = { type: 'object', properties: {} }

export async function execute() {
  return runTool('browser_back', {})
}
