import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  calculateColumnCount,
  computeVirtualSlice,
} from './virtualGridMath.js';

function getScrollParent(node) {
  if (!node || typeof window === 'undefined') return null;
  let current = node.parentElement;
  while (current) {
    const { overflowY } = window.getComputedStyle(current);
    if (overflowY === 'auto' || overflowY === 'scroll') return current;
    current = current.parentElement;
  }
  return window;
}

export function VirtualSongGrid({
  songs = [],
  renderSong,
  keyExtractor = song => song?.songKey || song?.id || song?.driveFileId,
  className = 'songs-grid',
  minColumnWidth = 180,
  gap = 20,
  estimatedRowHeight = 282,
  overscanRows = 2,
  hasMore = false,
  onLoadMore,
  remainingCount = 0,
}) {
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(800);
  const [containerTop, setContainerTop] = useState(0);
  const [pinnedIndex, setPinnedIndex] = useState(-1);
  const [measuredRowHeight, setMeasuredRowHeight] = useState(estimatedRowHeight);
  const loadingMoreRef = useRef(false);

  // Measure container width and responsive column count
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (width > 0) setContainerWidth(width);
      }
    });

    observer.observe(node);
    setContainerWidth(node.clientWidth || 0);

    return () => observer.disconnect();
  }, []);

  // Track scroll position and viewport size of scroll container
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;

    const scrollParent = getScrollParent(node);
    if (!scrollParent) return undefined;

    let rafId = null;

    const updateScrollMetrics = () => {
      if (!containerRef.current) return;
      const isWin = scrollParent === window;
      const currentScrollTop = isWin ? window.scrollY || document.documentElement.scrollTop : scrollParent.scrollTop;
      const currentViewportHeight = isWin ? window.innerHeight : scrollParent.clientHeight;

      const nodeRect = containerRef.current.getBoundingClientRect();
      const parentTop = isWin ? 0 : scrollParent.getBoundingClientRect().top;
      const relativeTop = nodeRect.top - parentTop + currentScrollTop;

      setScrollTop(currentScrollTop);
      setViewportHeight(currentViewportHeight);
      setContainerTop(relativeTop);

      // Auto-paginate when scrolled near bottom
      if (hasMore && typeof onLoadMore === 'function' && !loadingMoreRef.current) {
        const scrollBottom = currentScrollTop + currentViewportHeight;
        const containerBottom = relativeTop + (containerRef.current.offsetHeight || 0);
        if (scrollBottom >= containerBottom - 600) {
          loadingMoreRef.current = true;
          onLoadMore();
          setTimeout(() => { loadingMoreRef.current = false; }, 400);
        }
      }
    };

    const handleScroll = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updateScrollMetrics);
    };

    updateScrollMetrics();
    scrollParent.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll, { passive: true });

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      scrollParent.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [hasMore, onLoadMore]);

  // Keep focused card mounted even during rapid scrolling
  const handleFocusIn = useCallback(event => {
    const card = event.target.closest('.song-card');
    if (card && containerRef.current) {
      const allCards = containerRef.current.querySelectorAll('.song-card');
      const idx = Array.prototype.indexOf.call(allCards, card);
      if (idx >= 0) setPinnedIndex(idx);
    }
  }, []);

  const handleFocusOut = useCallback(() => {
    setPinnedIndex(-1);
  }, []);

  // Measure actual card row height from DOM if available
  const measureFirstChild = useCallback(el => {
    if (el) {
      const firstChild = el.querySelector('.song-card');
      if (firstChild) {
        const h = firstChild.getBoundingClientRect().height;
        if (h > 100 && Math.abs(h - measuredRowHeight) > 4) {
          setMeasuredRowHeight(Math.round(h));
        }
      }
    }
  }, [measuredRowHeight]);

  const columns = useMemo(() => {
    return calculateColumnCount(containerWidth, minColumnWidth, gap);
  }, [containerWidth, minColumnWidth, gap]);

  const virtualSlice = useMemo(() => {
    return computeVirtualSlice({
      totalItems: songs.length,
      columns,
      rowHeight: measuredRowHeight,
      gap,
      scrollTop,
      viewportHeight,
      containerTop,
      overscanRows,
      pinnedIndex,
    });
  }, [songs.length, columns, measuredRowHeight, gap, scrollTop, viewportHeight, containerTop, overscanRows, pinnedIndex]);

  const { startIndex, endIndex, totalHeight, topOffset } = virtualSlice;
  const visibleSongs = useMemo(() => {
    return songs.slice(startIndex, endIndex);
  }, [songs, startIndex, endIndex]);

  return (
    <div
      ref={containerRef}
      className="virtual-song-grid-container"
      style={{
        position: 'relative',
        width: '100%',
        minHeight: `${totalHeight}px`,
      }}
      onFocus={handleFocusIn}
      onBlur={handleFocusOut}
    >
      <div
        ref={measureFirstChild}
        className={className}
        style={{
          transform: topOffset > 0 ? `translateY(${topOffset}px)` : undefined,
          willChange: 'transform',
        }}
      >
        {visibleSongs.map((song, i) => {
          const index = startIndex + i;
          return (
            <React.Fragment key={keyExtractor(song, index)}>
              {renderSong(song, index)}
            </React.Fragment>
          );
        })}
      </div>

      {hasMore && (
        <div style={{ marginTop: '24px', textAlign: 'center' }}>
          <button
            type="button"
            className="load-more-btn"
            onClick={onLoadMore}
          >
            Show more {remainingCount > 0 ? `(${remainingCount} remaining)` : ''}
          </button>
        </div>
      )}
    </div>
  );
}
