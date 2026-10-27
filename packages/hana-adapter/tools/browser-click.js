import { runTool } from '../lib/bridge-core.js'

export const name = 'browser_click'

export const description =
  'Click an element from the latest browser_snapshot by index; include frame for an iframe target.'

export const parameters = {
  type: 'object',
  properties: {
    index: { type: 'number', description: 'Element index from the browser_snapshot inventory.' },
    frame: { type: 'number', description: 'Iframe number from browser_snapshot; omit for the top page.' },
  },
  required: ['index'],
}

export async function execute(input = {}) {
  const args = { index: input.index }
  if (input.frame !== undefined) args.frame = input.frame
  return runTool('browser_click', args)
}
