import { runTool } from '../lib/bridge-core.js'

export const name = 'browser_press'

export const description =
  'Send one key press, such as Enter, Tab, Escape, an arrow, Backspace, or Delete.'

export const parameters = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Key name using KeyboardEvent.key semantics.' },
    frame: { type: 'number', description: 'Iframe number from browser_snapshot; omit for the top page.' },
  },
  required: ['key'],
}

export async function execute(input = {}) {
  const args = { key: input.key }
  if (input.frame !== undefined) args.frame = input.frame
  return runTool('browser_press', args)
}
