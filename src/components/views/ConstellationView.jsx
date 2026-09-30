import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Rotate3d, Sparkles } from 'lucide-react';
import { kMeansCluster, projectEmbeddingsTo3D } from '../../services/tasteEmbeddingService.js';
import { getSongGenres, getSongMoods } from '../../services/exploreService.js';

const MAX_CLUSTER_SONGS = 1200;
const CLUSTER_COLORS = ['#78a7ff', '#c48cff', '#55d6be', '#ffb86b', '#ff7f9f', '#e7df78', '#74d99f', '#a7a7ff'];

// Frames the 5th-95th percentile box of each axis, so the cloud sits centred
// and a few outliers can't squash everything into a corner.
function normalisePoints(songs) {
  if (!songs.length) return [];
  const axes = ['coordX', 'coordY', 'coordZ'].map(axis => {
    const values = songs.map(song => song[axis] || 0).sort((a, b) => a - b);
    const low = values[Math.floor((values.length - 1) * 0.05)];
    const high = values[Math.ceil((values.length - 1) * 0.95)];
    return { axis, centre: (low + high) / 2, spread: (high - low) / 2 || 1 };
  });
  const clamp = value => Math.max(-1.25, Math.min(1.25, value));
  const [x, y, z] = axes.map(({ axis, centre, spread }) => song => clamp(((song[axis] || 0) - centre) / spread));
  return songs.map(song => ({ ...song, x: x(song), y: y(song), z: z(song) }));
}

const GENERIC_LABELS = new Set(['Open format', 'Discovery']);

/** Names a cluster after its most common mood/genre, falling back to its top artist. */
function clusterLabel(clusterSongs) {
  const counts = new Map();
  const artists = new Map();
  for (const song of clusterSongs) {
    for (const label of [...getSongMoods(song), ...getSongGenres(song)]) {
      if (!GENERIC_LABELS.has(label)) counts.set(label, (counts.get(label) || 0) + 1);
    }
    if (song.artist) artists.set(song.artist, (artists.get(song.artist) || 0) + 1);
  }
  const top = entries => [...entries].sort((a, b) => b[1] - a[1])[0];
  const [facet, facetCount = 0] = top(counts.entries()) || [];
  const [artist] = top(artists.entries()) || [];
  if (facet && facetCount >= Math.max(2, clusterSongs.length * 0.25)) return artist ? `${facet} · ${artist}` : facet;
  return artist || 'Mixed';
}

// Matches the vertex shader: a square viewport of min(width, height) keeps the map undistorted.
function screenPosition(point, width, height, zoom, rotation) {
  const cosY = Math.cos(rotation.y);
  const sinY = Math.sin(rotation.y);
  const rotatedX = point.x * cosY - point.z * sinY;
  const rotatedZ = point.x * sinY + point.z * cosY;
  const cosX = Math.cos(rotation.x);
  const sinX = Math.sin(rotation.x);
  const rotatedY = point.y * cosX - rotatedZ * sinX;
  const finalZ = point.y * sinX + rotatedZ * cosX;
  const perspective = 2.7 / (2.7 + finalZ);
  const scale = Math.min(width, height) * 0.36 * zoom * perspective;
  return { x: (width / 2) + rotatedX * scale, y: (height / 2) - rotatedY * scale, depth: finalZ };
}

function shader(gl, type, source) {
  const handle = gl.createShader(type);
  gl.shaderSource(handle, source);
  gl.compileShader(handle);
  if (!gl.getShaderParameter(handle, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(handle);
    gl.deleteShader(handle);
    throw new Error(message || 'WebGL shader failed to compile.');
  }
  return handle;
}

function createPointProgram(gl) {
  const vertex = shader(gl, gl.VERTEX_SHADER, `
    attribute vec3 a_position;
    attribute vec3 a_color;
    attribute float a_size;
    uniform float u_rotation_x;
    uniform float u_rotation_y;
    uniform float u_zoom;
    uniform float u_aspect;
    varying vec3 v_color;
    void main() {
      float cosY = cos(u_rotation_y);
      float sinY = sin(u_rotation_y);
      vec3 p = vec3(a_position.x * cosY - a_position.z * sinY, a_position.y, a_position.x * sinY + a_position.z * cosY);
      float cosX = cos(u_rotation_x);
      float sinX = sin(u_rotation_x);
      p = vec3(p.x, p.y * cosX - p.z * sinX, p.y * sinX + p.z * cosX);
      float perspective = 2.7 / (2.7 + p.z);
      float s = perspective * u_zoom * 0.72;
      gl_Position = vec4(p.x * s * min(1.0, 1.0 / u_aspect), p.y * s * min(1.0, u_aspect), p.z * 0.2, 1.0);
      gl_PointSize = a_size * (0.8 + perspective * 0.8);
      v_color = a_color;
    }
  `);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec3 v_color;
    void main() {
      float edge = distance(gl_PointCoord, vec2(0.5));
      if (edge > 0.5) discard;
      float core = 1.0 - smoothstep(0.12, 0.22, edge);
      float glow = (1.0 - smoothstep(0.18, 0.5, edge)) * 0.55;
      gl_FragColor = vec4(mix(v_color, vec3(1.0), core * 0.35), max(core, glow));
    }
  `);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('WebGL point program failed to link.');
  return program;
}

export function ConstellationView({ songs = [], currentSong, onPlaySong, onAddToQueue, onPlayCluster }) {
  const canvasRef = useRef(null);
  const wrapperRef = useRef(null);
  const rotationRef = useRef({ x: 0.36, y: 0.55 });
  const dragRef = useRef(null);
  const movedRef = useRef(false);
  const [hoveredSong, setHoveredSong] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  const [filterMode, setFilterMode] = useState('all');
  const [webglReady, setWebglReady] = useState(true);

  const filteredSongs = useMemo(() => {
    const filtered = filterMode === 'cached'
      ? songs.filter(song => song.isCached || song.hasBlob)
      : filterMode === 'downloaded'
        ? songs.filter(song => song.isDownloaded)
        : songs;
    if (filtered.length <= MAX_CLUSTER_SONGS) return filtered;
    const limited = filtered.slice(0, MAX_CLUSTER_SONGS);
    if (currentSong && !limited.some(song => song.songKey === currentSong.songKey)) limited[limited.length - 1] = currentSong;
    return limited;
  }, [currentSong, filterMode, songs]);

  const points = useMemo(() => normalisePoints(projectEmbeddingsTo3D(kMeansCluster(filteredSongs, { maxClusters: 8 }))), [filteredSongs]);
  const clusterSummary = useMemo(() => {
    const byCluster = new Map();
    points.forEach(point => {
      if (!byCluster.has(point.clusterId)) byCluster.set(point.clusterId, []);
      byCluster.get(point.clusterId).push(point);
    });
    return [...byCluster.entries()]
      .map(([clusterId, clusterSongs]) => ({ clusterId, songs: clusterSongs, label: clusterLabel(clusterSongs) }))
      .sort((a, b) => b.songs.length - a.songs.length);
  }, [points]);

  // Zoom is read per frame from a ref so zooming doesn't rebuild the WebGL program.
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return undefined;
    let gl;
    try {
      gl = canvas.getContext('webgl', { alpha: true, antialias: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL is unavailable.');
      const program = createPointProgram(gl);
      const positionBuffer = gl.createBuffer();
      const colorBuffer = gl.createBuffer();
      const sizeBuffer = gl.createBuffer();
      const positionLocation = gl.getAttribLocation(program, 'a_position');
      const colorLocation = gl.getAttribLocation(program, 'a_color');
      const sizeLocation = gl.getAttribLocation(program, 'a_size');
      const uniforms = {
        rotationX: gl.getUniformLocation(program, 'u_rotation_x'),
        rotationY: gl.getUniformLocation(program, 'u_rotation_y'),
        zoom: gl.getUniformLocation(program, 'u_zoom'),
        aspect: gl.getUniformLocation(program, 'u_aspect'),
      };
      const positions = new Float32Array(points.flatMap(point => [point.x, point.y, point.z]));
      const sizes = new Float32Array(points.map(point => point.songKey === currentSong?.songKey ? 16 : 7 + Math.min(7, point.clusterSize / 40)));
      const colors = new Float32Array(points.flatMap(point => {
        if (point.songKey === currentSong?.songKey) return [1, 1, 1];
        const color = CLUSTER_COLORS[point.clusterId % CLUSTER_COLORS.length];
        return [parseInt(color.slice(1, 3), 16) / 255, parseInt(color.slice(3, 5), 16) / 255, parseInt(color.slice(5, 7), 16) / 255];
      }));
      const bindAttribute = (buffer, location, data, size) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      };
      bindAttribute(positionBuffer, positionLocation, positions, 3);
      bindAttribute(colorBuffer, colorLocation, colors, 3);
      bindAttribute(sizeBuffer, sizeLocation, sizes, 1);
      gl.enable(gl.BLEND);
      // Normal alpha blending keeps dense clusters their own colour instead of saturating to white.
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0.025, 0.03, 0.065, 1);
      let frame;
      const render = () => {
        const width = canvas.width;
        const height = canvas.height;
        gl.viewport(0, 0, width, height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(program);
        gl.uniform1f(uniforms.rotationX, rotationRef.current.x);
        gl.uniform1f(uniforms.rotationY, rotationRef.current.y);
        gl.uniform1f(uniforms.zoom, zoomRef.current);
        gl.uniform1f(uniforms.aspect, width / Math.max(1, height));
        gl.drawArrays(gl.POINTS, 0, points.length);
        if (!dragRef.current) rotationRef.current.y += 0.0014;
        frame = window.requestAnimationFrame(render);
      };
      render();
      return () => {
        window.cancelAnimationFrame(frame);
        gl.deleteBuffer(positionBuffer);
        gl.deleteBuffer(colorBuffer);
        gl.deleteBuffer(sizeBuffer);
        gl.deleteProgram(program);
      };
    } catch (error) {
      console.warn('3D constellation unavailable:', error);
      window.setTimeout(() => setWebglReady(false), 0);
      return undefined;
    }
  }, [currentSong?.songKey, points]);

  useEffect(() => {
    const updateSize = () => {
      const canvas = canvasRef.current;
      const wrapper = wrapperRef.current;
      if (!canvas || !wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
    };
    updateSize();
    // Observe the wrapper, not the window: layout changes (sidebar, legend wrap) resize it too.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateSize) : null;
    if (observer && wrapperRef.current) observer.observe(wrapperRef.current);
    else window.addEventListener('resize', updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  const findHovered = event => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let closest = null;
    let distance = 28;
    points.forEach(point => {
      const screen = screenPosition(point, rect.width, rect.height, zoom, rotationRef.current);
      const nextDistance = Math.hypot(screen.x - x, screen.y - y);
      if (nextDistance < distance) {
        closest = point;
        distance = nextDistance;
      }
    });
    if (closest) setTooltipPos({ x, y });
    setHoveredSong(closest);
    return closest;
  };

  const handlePointerDown = event => {
    movedRef.current = false;
    dragRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handlePointerMove = event => {
    if (dragRef.current) {
      const dx = event.clientX - dragRef.current.x;
      const dy = event.clientY - dragRef.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true;
      rotationRef.current.y += dx * 0.008;
      rotationRef.current.x = Math.max(-1.2, Math.min(1.2, rotationRef.current.x + dy * 0.008));
      dragRef.current = { x: event.clientX, y: event.clientY };
    } else {
      findHovered(event);
    }
  };
  const handlePointerUp = event => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const handleClick = event => {
    if (movedRef.current) return;
    // Resolve the target at click time so taps on touch screens (no hover) work.
    const target = findHovered(event);
    if (!target) return;
    if (event.shiftKey) onAddToQueue?.(target);
    else onPlaySong?.(target);
  };

  const currentPoint = points.find(point => point.songKey === currentSong?.songKey);
  const currentCluster = currentPoint && clusterSummary.find(cluster => cluster.clusterId === currentPoint.clusterId);

  return (
    <div className="constellation-view">
      <div className="constellation-header">
        <div className="constellation-title-group">
          <Sparkles className="constellation-icon" size={22} />
          <div>
            <h2 className="constellation-title">Music clusters</h2>
            <p className="constellation-subtitle">Songs that sound alike orbit together. Drag to orbit, click a star to play, or tap a cluster to play it as a mix.</p>
          </div>
        </div>
        <div className="constellation-controls">
          <div className="constellation-filters">
            <button className={`filter-chip ${filterMode === 'all' ? 'filter-chip--active' : ''}`} onClick={() => setFilterMode('all')}>All ({songs.length})</button>
            <button className={`filter-chip ${filterMode === 'cached' ? 'filter-chip--active' : ''}`} onClick={() => setFilterMode('cached')}>Cached ({songs.filter(song => song.isCached || song.hasBlob).length})</button>
          </div>
          <div className="constellation-zoom-controls">
            <button className="neumorphic-button neumorphic-button--icon" onClick={() => setZoom(value => Math.max(.6, value - .2))} aria-label="Zoom out">-</button>
            <span className="zoom-level">{Math.round(zoom * 100)}%</span>
            <button className="neumorphic-button neumorphic-button--icon" onClick={() => setZoom(value => Math.min(2.5, value + .2))} aria-label="Zoom in">+</button>
          </div>
        </div>
      </div>
      {currentPoint && <div className="constellation-now-playing"><Rotate3d size={15} /><span>Now playing: <strong>{currentPoint.track}</strong> · in {currentCluster?.label || 'this cluster'}</span></div>}
      <div className="constellation-cluster-legend" role="region" aria-label="Music clusters">
        {clusterSummary.map(({ clusterId, songs: clusterSongs, label }) => (
          <button
            type="button"
            key={clusterId}
            className="constellation-cluster-chip"
            onClick={() => onPlayCluster?.(clusterSongs)}
            disabled={!onPlayCluster}
            title={onPlayCluster ? `Play all ${clusterSongs.length} songs in ${label}` : undefined}
          >
            <i style={{ background: CLUSTER_COLORS[clusterId % CLUSTER_COLORS.length] }} />{label} · {clusterSongs.length}
          </button>
        ))}
        {filteredSongs.length < songs.length && <small>Showing the first {filteredSongs.length.toLocaleString()} songs for a smooth map.</small>}
      </div>
      <div className="constellation-canvas-wrapper" ref={wrapperRef} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerLeave={() => { dragRef.current = null; setHoveredSong(null); }} onClick={handleClick}>
        <canvas ref={canvasRef} className="constellation-canvas" aria-label="3D music cluster map" />
        {!webglReady && <div className="constellation-fallback">3D rendering is unavailable in this browser. Your library is still available in Ready and Search.</div>}
        {hoveredSong && (
          <div className="constellation-tooltip" style={{ left: `${tooltipPos.x + 14}px`, top: `${tooltipPos.y + 14}px` }}>
            <div className="tooltip-title">{hoveredSong.track || 'Unknown Track'}</div>
            <div className="tooltip-artist">{hoveredSong.artist || 'Unknown Artist'}</div>
            <div className="tooltip-action-hint"><Play size={12} style={{ marginRight: 4 }} />{onAddToQueue ? 'Click to play · Shift-click to queue' : 'Click to play'}</div>
          </div>
        )}
      </div>
    </div>
  );
}
