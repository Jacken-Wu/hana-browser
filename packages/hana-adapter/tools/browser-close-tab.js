import { runTool } from '../lib/bridge-core.js'

export const name = 'browser_close_tab'

export const description =
  'Close an open tab by browser_list_tabs tabId when the task requires it.'

export const parameters = {
  type: 'object',
  properties: {
    tabId: { type: 'number', description: 'Stable tabId returned by browser_list_tabs.' },
  },
  required: ['tabId'],
}

export async function execute(input = {}) {
  return runTool('browser_close_tab', { tabId: input.tabId })
}
