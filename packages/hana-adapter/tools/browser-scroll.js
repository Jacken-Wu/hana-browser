import { runTool } from '../lib/bridge-core.js'

export const name = 'browser_scroll'

export const description = 'Scroll up, down, top, or bottom; amount is optional pixels.'

export const parameters = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction.' },
    amount: { type: 'number', description: 'Pixels to scroll; ignored for top and bottom.' },
    frame: { type: 'number', description: 'Iframe number from browser_snapshot; omit for the top page.' },
  },
  required: ['direction'],
}

export async function execute(input = {}) {
  const args = { direction: input.direction }
  if (input.amount !== undefined) args.amount = input.amount
  if (input.frame !== undefined) args.frame = input.frame
  return runTool('browser_scroll', args)
}
