import { expect, test } from 'claude-code/testing'

import { fitCells, pngSize } from '../hooks/prepare'

// 1x1 PNG header (IHDR width 1, height 1) followed by a few bytes.
const OnePixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('pngSize reads the IHDR size and refuses non-PNG', async () => {
  expect(pngSize(OnePixel)).toEqual({ width: 1, height: 1 })
  expect(pngSize('/9j/4AAQSkZJRgABAQAAAQABAAD')).toBe(undefined)
})

test('fitCells keeps the aspect ratio and caps the height', async () => {
  // Wide picture: limited by width.
  expect(fitCells({ width: 1600, height: 400 }, { columns: 100, maxRows: 20 })).toEqual({ columns: 100, rows: 13 })
  // Tall picture: limited by height, columns shrink to match.
  expect(fitCells({ width: 400, height: 1600 }, { columns: 100, maxRows: 20 })).toEqual({ columns: 10, rows: 20 })
  // Small icon: not blown up.
  expect(fitCells({ width: 64, height: 64 }, { columns: 100, maxRows: 20 })).toEqual({ columns: 7, rows: 4 })
})
