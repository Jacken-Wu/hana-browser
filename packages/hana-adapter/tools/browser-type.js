import { runTool } from '../lib/bridge-core.js'

export const name = 'browser_type'

export const description =
  'Append text to a field from browser_snapshot, or clear it first with replace=true. '
  + 'Include frame for an iframe target. Sensitive values are never returned.'

export const parameters = {
  type: 'object',
  properties: {
    index: { type: 'number', description: 'Form-field index from the browser_snapshot forms inventory.' },
    frame: { type: 'number', description: 'Iframe number from browser_snapshot; omit for the top page.' },
    text: { type: 'string', description: 'Text to enter.' },
    replace: { type: 'boolean', description: 'When true, clear the existing value first. Defaults to append.' },
  },
  required: ['index', 'text'],
}

export async function execute(input = {}) {
  const args = { index: input.index, text: input.text }
  if (input.frame !== undefined) args.frame = input.frame
  if (input.replace !== undefined) args.replace = input.replace
  return runTool('browser_type', args)
}
