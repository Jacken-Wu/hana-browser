import { runTool } from '../lib/bridge-core.js'

export const name = 'browser_open_tab'

export const description =
  'Open an HTTP(S) URL in a new tab and make it the controlled target. '
  + 'Activates the tab by default; set active:false to keep the current visible tab in front.'

export const parameters = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Complete http or https URL.' },
    active: { type: 'boolean', description: 'Bring the new tab to the front. Defaults to true.' },
  },
  required: ['url'],
}

export async function execute(input = {}) {
  const args = { url: input.url }
  if (input.active !== undefined) args.active = input.active
  return runTool('browser_open_tab', args)
}
