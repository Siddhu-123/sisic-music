/**
 * Pure helper functions for grid virtualization calculations.
 */

export function calculateColumnCount(containerWidth, minColumnWidth = 180, gap = 20) {
  if (!containerWidth || containerWidth <= 0) return 1;
  const safeMinWidth = Math.max(80, minColumnWidth);
  const safeGap = Math.max(0, gap);
  const cols = Math.floor((containerWidth + safeGap) / (safeMinWidth + safeGap));
  return Math.max(1, cols);
}

export function calculateTotalHeight(totalItems, columns, rowHeight, gap = 20) {
  if (!totalItems || totalItems <= 0 || !columns || columns <= 0) return 0;
  const totalRows = Math.ceil(totalItems / columns);
  const safeRowHeight = Math.max(1, rowHeight);
  const safeGap = Math.max(0, gap);
  return totalRows * safeRowHeight + Math.max(0, totalRows - 1) * safeGap;
}

export function computeVirtualSlice({
  totalItems = 0,
  columns = 1,
  rowHeight = 280,
  gap = 20,
  scrollTop = 0,
  viewportHeight = 800,
  containerTop = 0,
  overscanRows = 2,
  pinnedIndex = -1,
}) {
  if (!totalItems || totalItems <= 0) {
    return {
      startRow: 0,
      endRow: 0,
      startIndex: 0,
      endIndex: 0,
      totalRows: 0,
      totalHeight: 0,
      topOffset: 0,
    };
  }

  const safeColumns = Math.max(1, columns);
  const safeRowHeight = Math.max(1, rowHeight);
  const safeGap = Math.max(0, gap);
  const rowHeightWithGap = safeRowHeight + safeGap;
  const totalRows = Math.ceil(totalItems / safeColumns);
  const totalHeight = calculateTotalHeight(totalItems, safeColumns, safeRowHeight, safeGap);

  // Position of scroll relative to grid container top
  const relativeScrollTop = Math.max(0, scrollTop - containerTop);

  const rawStartRow = Math.floor((relativeScrollTop - overscanRows * rowHeightWithGap) / rowHeightWithGap);
  let startRow = Math.max(0, rawStartRow);

  const rawEndRow = Math.ceil((relativeScrollTop + viewportHeight + overscanRows * rowHeightWithGap) / rowHeightWithGap);
  let endRow = Math.min(totalRows - 1, Math.max(startRow, rawEndRow));

  // Pinned item (e.g. keyboard focus or active context menu) must stay mounted
  if (pinnedIndex >= 0 && pinnedIndex < totalItems) {
    const pinnedRow = Math.floor(pinnedIndex / safeColumns);
    startRow = Math.min(startRow, pinnedRow);
    endRow = Math.max(endRow, pinnedRow);
  }

  const startIndex = startRow * safeColumns;
  const endIndex = Math.min(totalItems, (endRow + 1) * safeColumns);
  const topOffset = startRow * rowHeightWithGap;

  return {
    startRow,
    endRow,
    startIndex,
    endIndex,
    totalRows,
    totalHeight,
    topOffset,
  };
}
