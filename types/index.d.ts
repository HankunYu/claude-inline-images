// Max height of an inline image, in terminal rows.
export type MaxRows = number

declare module 'claude-code' {
  interface PluginState {
    'inline-images': { maxRows: MaxRows }
  }
}
