import React, { useRef, useEffect, useState, useMemo } from 'react';
import { Sparkles, Play } from 'lucide-react';
import { projectEmbeddingsTo2D } from '../../services/tasteEmbeddingService.js';
import { hashString } from '../../services/artworkService.js';

export function ConstellationView({ songs = [], currentSong, onPlaySong, onAddToQueue }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [hoveredSong, setHoveredSong] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [filterMode, setFilterMode] = useState('all'); // all | downloaded | cached

  const filteredSongs = useMemo(() => {
    if (filterMode === 'downloaded') return songs.filter(s => s.isDownloaded);
    if (filterMode === 'cached') return songs.filter(s => s.isCached || s.hasBlob);
    return songs;
  }, [songs, filterMode]);

  const projectedStars = useMemo(() => {
    if (filteredSongs.length === 0) return [];
    return projectEmbeddingsTo2D(filteredSongs);
  }, [filteredSongs]);

  // Determine coordinate bounding box
  const bounds = useMemo(() => {
    if (projectedStars.length === 0) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const star of projectedStars) {
      if (star.coordX < minX) minX = star.coordX;
      if (star.coordX > maxX) maxX = star.coordX;
      if (star.coordY < minY) minY = star.coordY;
      if (star.coordY > maxY) maxY = star.coordY;
    }
    const padX = (maxX - minX) * 0.1 || 0.5;
    const padY = (maxY - minY) * 0.1 || 0.5;
    return {
      minX: minX - padX,
      maxX: maxX + padX,
      minY: minY - padY,
      maxY: maxY + padY,
    };
  }, [projectedStars]);

  // Draw galaxy onto HTML5 canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Deep galaxy gradient background
    const bgGrad = ctx.createRadialGradient(width / 2, height / 2, 50, width / 2, height / 2, width * 0.7);
    bgGrad.addColorStop(0, '#1a1a2e');
    bgGrad.addColorStop(0.6, '#12121f');
    bgGrad.addColorStop(1, '#0b0b14');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Map star coords to canvas pixels
    const mapToCanvas = (cx, cy) => {
      const xNorm = (cx - bounds.minX) / (bounds.maxX - bounds.minX || 1);
      const yNorm = (cy - bounds.minY) / (bounds.maxY - bounds.minY || 1);
      const centerX = width / 2;
      const centerY = height / 2;
      const px = centerX + (xNorm * (width - 80) + 40 - centerX) * zoom;
      const py = centerY + (yNorm * (height - 80) + 40 - centerY) * zoom;
      return { x: px, y: py };
    };

    // Draw constellation connection lines for close neighbors
    ctx.lineWidth = 0.8;
    for (let i = 0; i < projectedStars.length; i++) {
      const s1 = projectedStars[i];
      const p1 = mapToCanvas(s1.coordX, s1.coordY);

      for (let j = i + 1; j < projectedStars.length; j++) {
        const s2 = projectedStars[j];
        const dx = s1.coordX - s2.coordX;
        const dy = s1.coordY - s2.coordY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 0.25) {
          const p2 = mapToCanvas(s2.coordX, s2.coordY);
          const alpha = (1 - dist / 0.25) * 0.25;
          ctx.strokeStyle = `rgba(130, 160, 255, ${alpha})`;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
      }
    }

    // Draw each star
    projectedStars.forEach((star) => {
      const { x, y } = mapToCanvas(star.coordX, star.coordY);
      const isCurrent = currentSong && (currentSong.songKey === star.songKey);
      const isHovered = hoveredSong && (hoveredSong.songKey === star.songKey);
      const hash = hashString(star.songKey);
      const hue = hash % 360;

      // Glow effect
      const radius = isCurrent ? 8 : (isHovered ? 6 : 3.5);
      const glowGrad = ctx.createRadialGradient(x, y, 0, x, y, radius * 3);
      glowGrad.addColorStop(0, `hsla(${hue}, 90%, 75%, ${isCurrent || isHovered ? 0.9 : 0.6})`);
      glowGrad.addColorStop(0.5, `hsla(${hue}, 80%, 60%, ${isCurrent || isHovered ? 0.4 : 0.15})`);
      glowGrad.addColorStop(1, 'rgba(0,0,0,0)');

      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(x, y, radius * 3, 0, Math.PI * 2);
      ctx.fill();

      // Star core
      ctx.fillStyle = isCurrent ? '#ffffff' : `hsl(${hue}, 85%, 70%)`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [projectedStars, bounds, zoom, currentSong, hoveredSong]);

  // Handle canvas resize
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current && canvasRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        canvasRef.current.width = Math.max(320, rect.width);
        canvasRef.current.height = Math.max(380, rect.height || 500);
      }
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  const handleCanvasMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const width = canvas.width;
    const height = canvas.height;

    let closest = null;
    let minDistance = 24; // hover hit radius

    projectedStars.forEach((star) => {
      const xNorm = (star.coordX - bounds.minX) / (bounds.maxX - bounds.minX || 1);
      const yNorm = (star.coordY - bounds.minY) / (bounds.maxY - bounds.minY || 1);
      const centerX = width / 2;
      const centerY = height / 2;
      const px = centerX + (xNorm * (width - 80) + 40 - centerX) * zoom;
      const py = centerY + (yNorm * (height - 80) + 40 - centerY) * zoom;

      const dist = Math.hypot(mouseX - px, mouseY - py);
      if (dist < minDistance) {
        minDistance = dist;
        closest = star;
      }
    });

    setHoveredSong(closest);
    if (closest) {
      setTooltipPos({ x: mouseX, y: mouseY });
    }
  };

  const handleCanvasClick = (event) => {
    if (!hoveredSong) return;
    if (event.shiftKey && onAddToQueue) {
      onAddToQueue(hoveredSong);
    } else if (onPlaySong) {
      onPlaySong(hoveredSong);
    }
  };

  return (
    <div className="constellation-view" ref={containerRef}>
      <div className="constellation-header">
        <div className="constellation-title-group">
          <Sparkles className="constellation-icon" size={22} />
          <div>
            <h2 className="constellation-title">Taste Constellation</h2>
            <p className="constellation-subtitle">
              Interactive 2D galaxy of your music library clustered by acoustic & semantic similarity.
            </p>
          </div>
        </div>

        <div className="constellation-controls">
          <div className="constellation-filters">
            <button
              className={`filter-chip ${filterMode === 'all' ? 'filter-chip--active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              All ({songs.length})
            </button>
            <button
              className={`filter-chip ${filterMode === 'cached' ? 'filter-chip--active' : ''}`}
              onClick={() => setFilterMode('cached')}
            >
              Cached ({songs.filter(s => s.isCached || s.hasBlob).length})
            </button>
          </div>

          <div className="constellation-zoom-controls">
            <button className="neumorphic-button neumorphic-button--icon" onClick={() => setZoom(z => Math.max(0.6, z - 0.2))}>-</button>
            <span className="zoom-level">{Math.round(zoom * 100)}%</span>
            <button className="neumorphic-button neumorphic-button--icon" onClick={() => setZoom(z => Math.min(2.5, z + 0.2))}>+</button>
          </div>
        </div>
      </div>

      <div className="constellation-canvas-wrapper" onClick={handleCanvasClick} onMouseMove={handleCanvasMouseMove} onMouseLeave={() => setHoveredSong(null)}>
        <canvas ref={canvasRef} className="constellation-canvas" />

        {hoveredSong && (
          <div
            className="constellation-tooltip"
            style={{
              left: `${tooltipPos.x + 14}px`,
              top: `${tooltipPos.y + 14}px`,
            }}
          >
            <div className="tooltip-title">{hoveredSong.track || 'Unknown Track'}</div>
            <div className="tooltip-artist">{hoveredSong.artist || 'Unknown Artist'}</div>
            <div className="tooltip-action-hint">
              <Play size={12} style={{ marginRight: '4px' }} />
              Click star to play
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
