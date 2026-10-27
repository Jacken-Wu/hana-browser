import { runTool } from '../lib/bridge-core.js'

export const name = 'browser_follow_tab'

export const description =
  'Control an open tab by browser_list_tabs tabId without activating it.'

export const parameters = {
  type: 'object',
  properties: {
    tabId: { type: 'number', description: 'Stable tabId returned by browser_list_tabs.' },
  },
  required: ['tabId'],
}

export async function execute(input = {}) {
  return runTool('browser_follow_tab', { tabId: input.tabId })
}
