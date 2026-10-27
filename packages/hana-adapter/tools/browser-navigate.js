import { runTool } from '../lib/bridge-core.js'

export const name = 'browser_navigate'

export const description =
  'Navigate the controlled tab to an HTTP(S) URL while preserving its login state.'

export const parameters = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Complete http or https URL.' },
  },
  required: ['url'],
}

export async function execute(input = {}) {
  return runTool('browser_navigate', { url: input.url })
}
