import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateColumnCount,
  calculateTotalHeight,
  computeVirtualSlice,
} from './virtualGridMath.js';

test('calculateColumnCount calculates responsive columns based on width and gap', () => {
  assert.equal(calculateColumnCount(0), 1);
  assert.equal(calculateColumnCount(320, 180, 20), 1);
  assert.equal(calculateColumnCount(600, 180, 20), 3); // (600 + 20) / 200 = 3.1 -> 3
  assert.equal(calculateColumnCount(1200, 200, 20), 5); // (1200 + 20) / 220 = 5.54 -> 5
});

test('calculateTotalHeight calculates exact pixel height accounting for gaps', () => {
  assert.equal(calculateTotalHeight(0, 4, 280, 20), 0);
  assert.equal(calculateTotalHeight(4, 4, 280, 20), 280); // 1 row, no gap
  assert.equal(calculateTotalHeight(5, 4, 280, 20), 280 * 2 + 20); // 2 rows, 1 gap = 580
  assert.equal(calculateTotalHeight(100, 4, 280, 20), 25 * 280 + 24 * 20); // 25 rows = 7480
});

test('computeVirtualSlice slices items with overscan and bounds within range', () => {
  const result = computeVirtualSlice({
    totalItems: 1000,
    columns: 4,
    rowHeight: 280,
    gap: 20,
    scrollTop: 0,
    viewportHeight: 600,
    overscanRows: 2,
  });

  // At top (scrollTop = 0):
  assert.equal(result.startRow, 0);
  assert.equal(result.startIndex, 0);
  assert.equal(result.topOffset, 0);
  // (600 + 2*300) / 300 = 4
  assert.equal(result.endRow, 4);
  assert.equal(result.endIndex, 20); // 5 rows * 4 = 20 items mounted
  assert.equal(result.totalRows, 250);
});

test('computeVirtualSlice updates offset and unmounts offscreen items when scrolled', () => {
  const result = computeVirtualSlice({
    totalItems: 1000,
    columns: 4,
    rowHeight: 280,
    gap: 20,
    scrollTop: 3000, // row 10
    viewportHeight: 600, // 2 rows visible
    overscanRows: 2, // 2 rows above, 2 rows below
  });

  // relativeScrollTop = 3000. rowHeightWithGap = 300
  // rawStartRow = (3000 - 600) / 300 = 8
  assert.equal(result.startRow, 8);
  assert.equal(result.topOffset, 8 * 300); // 2400px
  assert.equal(result.startIndex, 8 * 4); // 32
  // rawEndRow = (3000 + 600 + 600) / 300 = 14
  assert.equal(result.endRow, 14);
  assert.equal(result.endIndex, 15 * 4); // 60
  // Number of items mounted is (60 - 32) = 28 items out of 1000!
  assert.equal(result.endIndex - result.startIndex, 28);
});

test('computeVirtualSlice keeps pinnedIndex (e.g. keyboard focused item) within mounted window', () => {
  const result = computeVirtualSlice({
    totalItems: 1000,
    columns: 4,
    rowHeight: 280,
    gap: 20,
    scrollTop: 3000,
    viewportHeight: 600,
    overscanRows: 2,
    pinnedIndex: 4, // item 4 is in row 1 (above startRow 8)
  });

  // startRow should expand to include pinnedRow 1
  assert.equal(result.startRow, 1);
  assert.equal(result.startIndex, 4);
  assert.ok(result.startIndex <= 4 && 4 < result.endIndex);
});
