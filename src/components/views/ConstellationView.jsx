import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Rotate3d, Sparkles } from 'lucide-react';
import { buildGalaxy } from '../../services/galaxyService.js';

const MAX_CLUSTER_SONGS = 1200;
const CLUSTER_COLORS = ['#78a7ff', '#c48cff', '#55d6be', '#ffb86b', '#ff7f9f', '#e7df78', '#74d99f', '#a7a7ff'];
const HIT_RADIUS_PX = 28;
// Points sit inside the unit sphere; at the nearest depth perspective magnifies
// by 2.7 / 1.7, so 0.3 of the short side keeps the whole cloud on screen at 100%.
const MAP_SCALE = 0.3;

const clusterColor = clusterId => CLUSTER_COLORS[clusterId % CLUSTER_COLORS.length];

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
  const scale = Math.min(width, height) * MAP_SCALE * zoom * perspective;
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
    attribute float a_cluster;
    uniform float u_rotation_x;
    uniform float u_rotation_y;
    uniform float u_zoom;
    uniform float u_aspect;
    uniform float u_focus;
    varying vec3 v_color;
    varying float v_dim;
    void main() {
      float cosY = cos(u_rotation_y);
      float sinY = sin(u_rotation_y);
      vec3 p = vec3(a_position.x * cosY - a_position.z * sinY, a_position.y, a_position.x * sinY + a_position.z * cosY);
      float cosX = cos(u_rotation_x);
      float sinX = sin(u_rotation_x);
      p = vec3(p.x, p.y * cosX - p.z * sinX, p.y * sinX + p.z * cosX);
      float perspective = 2.7 / (2.7 + p.z);
      float s = perspective * u_zoom * ${(MAP_SCALE * 2).toFixed(3)};
      gl_Position = vec4(p.x * s * min(1.0, 1.0 / u_aspect), p.y * s * min(1.0, u_aspect), p.z * 0.2, 1.0);
      bool dimmed = u_focus >= 0.0 && abs(a_cluster - u_focus) > 0.5;
      gl_PointSize = a_size * (0.8 + perspective * 0.8) * (dimmed ? 0.7 : 1.0);
      v_color = a_color;
      v_dim = dimmed ? 0.16 : 1.0;
    }
  `);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec3 v_color;
    varying float v_dim;
    void main() {
      float edge = distance(gl_PointCoord, vec2(0.5));
      if (edge > 0.5) discard;
      float core = 1.0 - smoothstep(0.12, 0.22, edge);
      float glow = (1.0 - smoothstep(0.18, 0.5, edge)) * 0.55;
      gl_FragColor = vec4(mix(v_color, vec3(1.0), core * 0.35), max(core, glow) * v_dim);
    }
  `);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    throw new Error('WebGL point program failed to link.');
  }
  return program;
}

export function ConstellationView({ songs = [], currentSong, onPlaySong, onAddToQueue, onPlayCluster }) {
  const canvasRef = useRef(null);
  const wrapperRef = useRef(null);
  const rotationRef = useRef({ x: 0.36, y: 0.55 });
  const zoomRef = useRef(1);
  const focusRef = useRef(-1);
  const dragRef = useRef(null);
  const redrawRef = useRef(() => {});
  const movedRef = useRef(false);
  const [hoveredSong, setHoveredSong] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [filterMode, setFilterMode] = useState('all');
  const [spacePreference, setSpacePreference] = useState('auto');
  const [focusCluster, setFocusCluster] = useState(-1);
  const [webglReady, setWebglReady] = useState(true);

  const readyCount = useMemo(() => songs.filter(song => song.driveFileId).length, [songs]);
  const filteredSongs = useMemo(() => {
    const filtered = filterMode === 'ready' ? songs.filter(song => song.driveFileId) : songs;
    if (filtered.length <= MAX_CLUSTER_SONGS) return filtered;
    const limited = filtered.slice(0, MAX_CLUSTER_SONGS);
    if (currentSong && !limited.some(song => song.songKey === currentSong.songKey)) limited[limited.length - 1] = currentSong;
    return limited;
  }, [currentSong, filterMode, songs]);

  const galaxy = useMemo(() => buildGalaxy(filteredSongs, { preference: spacePreference }), [filteredSongs, spacePreference]);
  const { points, clusters } = galaxy;
  const clusterById = useMemo(() => new Map(clusters.map(cluster => [cluster.clusterId, cluster])), [clusters]);

  // Zoom and cluster focus are read per frame, so changing them never rebuilds the WebGL program.
  useEffect(() => { zoomRef.current = zoom; redrawRef.current(); }, [zoom]);
  useEffect(() => { focusRef.current = focusCluster; redrawRef.current(); }, [focusCluster]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return undefined;
    let gl;
    try {
      gl = canvas.getContext('webgl', { alpha: true, antialias: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL is unavailable.');
      const program = createPointProgram(gl);
      const buffers = [];
      const bindAttribute = (name, data, size) => {
        const buffer = gl.createBuffer();
        buffers.push(buffer);
        const location = gl.getAttribLocation(program, name);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      };
      const uniforms = Object.fromEntries(['u_rotation_x', 'u_rotation_y', 'u_zoom', 'u_aspect', 'u_focus'].map(name => [name, gl.getUniformLocation(program, name)]));
      const isCurrent = point => point.songKey === currentSong?.songKey;
      const clusterSizes = new Map(clusters.map(cluster => [cluster.clusterId, cluster.songs.length]));
      bindAttribute('a_position', new Float32Array(points.flatMap(point => [point.x, point.y, point.z])), 3);
      bindAttribute('a_color', new Float32Array(points.flatMap(point => {
        if (isCurrent(point)) return [1, 1, 1];
        const color = clusterColor(point.clusterId);
        return [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255);
      })), 3);
      bindAttribute('a_size', new Float32Array(points.map(point => (isCurrent(point) ? 16 : 7 + Math.min(7, (clusterSizes.get(point.clusterId) || 0) / 40)))), 1);
      bindAttribute('a_cluster', new Float32Array(points.map(point => point.clusterId)), 1);
      gl.enable(gl.BLEND);
      // Normal alpha blending keeps dense clusters their own colour instead of saturating to white.
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0.025, 0.03, 0.065, 1);
      let frame;
      let previousTime;
      const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
      const render = (time = performance.now()) => {
        window.cancelAnimationFrame(frame);
        if (document.hidden) { previousTime = undefined; return; }
        if (!dragRef.current && !motion.matches && previousTime !== undefined) rotationRef.current.y += Math.min(50, time - previousTime) * 0.000084;
        previousTime = time;
        const width = canvas.width;
        const height = canvas.height;
        gl.viewport(0, 0, width, height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(program);
        gl.uniform1f(uniforms.u_rotation_x, rotationRef.current.x);
        gl.uniform1f(uniforms.u_rotation_y, rotationRef.current.y);
        gl.uniform1f(uniforms.u_zoom, zoomRef.current);
        gl.uniform1f(uniforms.u_aspect, width / Math.max(1, height));
        gl.uniform1f(uniforms.u_focus, focusRef.current);
        gl.drawArrays(gl.POINTS, 0, points.length);
        if (!motion.matches) frame = window.requestAnimationFrame(render);
      };
      const refresh = () => { previousTime = undefined; render(); };
      redrawRef.current = refresh;
      document.addEventListener('visibilitychange', refresh);
      motion.addEventListener('change', refresh);
      render();
      return () => {
        redrawRef.current = () => {};
        document.removeEventListener('visibilitychange', refresh);
        motion.removeEventListener('change', refresh);
        window.cancelAnimationFrame(frame);
        buffers.forEach(buffer => gl.deleteBuffer(buffer));
        gl.deleteProgram(program);
      };
    } catch (error) {
      console.warn('3D constellation unavailable:', error);
      const timer = window.setTimeout(() => setWebglReady(false), 0);
      return () => window.clearTimeout(timer);
    }
  }, [clusters, currentSong?.songKey, points]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const updateSize = () => {
      const canvas = canvasRef.current;
      if (!canvas || !wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
      redrawRef.current();
    };
    updateSize();
    // Observe the stage, not the window: sidebar and legend changes resize it too.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateSize) : null;
    if (observer && wrapper) observer.observe(wrapper);
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
    let distance = HIT_RADIUS_PX;
    points.forEach(point => {
      if (focusRef.current >= 0 && point.clusterId !== focusRef.current) return;
      const screen = screenPosition(point, rect.width, rect.height, zoomRef.current, rotationRef.current);
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
      redrawRef.current();
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
    // Resolve the target at click time so taps on touch screens (which never hover) work.
    const target = findHovered(event);
    if (!target) return;
    if (event.shiftKey) onAddToQueue?.(target);
    else onPlaySong?.(target);
  };

  const currentPoint = points.find(point => point.songKey === currentSong?.songKey);
  const currentCluster = currentPoint && clusterById.get(currentPoint.clusterId);
  const hoveredCluster = hoveredSong && clusterById.get(hoveredSong.clusterId);
  const subtitle = galaxy.mode === 'audio'
    ? `Mapped by how songs sound (${galaxy.audio.count.toLocaleString()} analysed with ${galaxy.audio.model}).`
    : 'Mapped by title, artist and mood tags.';

  return (
    <div className="constellation-view">
      <div className="constellation-header">
        <div className="constellation-title-group">
          <Sparkles className="constellation-icon" size={22} />
          <div>
            <h2 className="constellation-title">Music galaxy</h2>
            <p className="constellation-subtitle">{subtitle} Drag to orbit, click a star to play, or pick a cluster to hear it as a mix.</p>
          </div>
        </div>
        <div className="constellation-controls">
          <div className="constellation-filters" role="group" aria-label="Songs on the map">
            <button type="button" className={`filter-chip ${filterMode === 'all' ? 'filter-chip--active' : ''}`} aria-pressed={filterMode === 'all'} onClick={() => setFilterMode('all')}>All ({songs.length})</button>
            <button type="button" className={`filter-chip ${filterMode === 'ready' ? 'filter-chip--active' : ''}`} aria-pressed={filterMode === 'ready'} onClick={() => setFilterMode('ready')}>Ready ({readyCount})</button>
          </div>
          {galaxy.audio && (
            <div className="constellation-filters" role="group" aria-label="Map by">
              <button type="button" className={`filter-chip ${galaxy.mode === 'audio' ? 'filter-chip--active' : ''}`} aria-pressed={galaxy.mode === 'audio'} onClick={() => setSpacePreference('auto')}>Sound</button>
              <button type="button" className={`filter-chip ${galaxy.mode === 'metadata' ? 'filter-chip--active' : ''}`} aria-pressed={galaxy.mode === 'metadata'} onClick={() => setSpacePreference('metadata')}>Tags</button>
            </div>
          )}
          <div className="constellation-zoom-controls">
            <button type="button" className="neumorphic-button neumorphic-button--icon" onClick={() => setZoom(value => Math.max(0.6, value - 0.2))} aria-label="Zoom out">−</button>
            <span className="zoom-level">{Math.round(zoom * 100)}%</span>
            <button type="button" className="neumorphic-button neumorphic-button--icon" onClick={() => setZoom(value => Math.min(2.5, value + 0.2))} aria-label="Zoom in">+</button>
          </div>
        </div>
      </div>
      {currentPoint && <div className="constellation-now-playing"><Rotate3d size={15} /><span>Now playing: <strong>{currentPoint.track}</strong> · in {currentCluster?.label || 'this cluster'}</span></div>}
      <div className="constellation-cluster-legend" role="group" aria-label="Clusters">
        {clusters.map(({ clusterId, songs: clusterSongs, label }) => (
          <button
            type="button"
            key={clusterId}
            className="constellation-cluster-chip"
            onClick={() => onPlayCluster?.(clusterSongs)}
            onMouseEnter={() => setFocusCluster(clusterId)}
            onMouseLeave={() => setFocusCluster(-1)}
            onFocus={() => setFocusCluster(clusterId)}
            onBlur={() => setFocusCluster(-1)}
            disabled={!onPlayCluster}
            title={onPlayCluster ? `Play all ${clusterSongs.length} songs in ${label}` : label}
          >
            <i style={{ background: clusterColor(clusterId) }} />{label} · {clusterSongs.length}
          </button>
        ))}
        {filteredSongs.length < songs.length && <small>Showing the first {filteredSongs.length.toLocaleString()} songs for a smooth map.</small>}
        {galaxy.excluded > 0 && <small>{galaxy.excluded.toLocaleString()} songs aren&apos;t analysed yet. Switch to Tags to see them.</small>}
      </div>
      <div className="constellation-canvas-wrapper" ref={wrapperRef} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={() => { dragRef.current = null; movedRef.current = true; }} onLostPointerCapture={() => { dragRef.current = null; }} onPointerLeave={() => { dragRef.current = null; setHoveredSong(null); }} onClick={handleClick}>
        <canvas ref={canvasRef} className="constellation-canvas" aria-label="3D music galaxy map" />
        {!webglReady && <div className="constellation-fallback">3D rendering is unavailable in this browser. Your library is still available in Ready and Search.</div>}
        {hoveredSong && (
          <div className="constellation-tooltip" style={{ left: `${tooltipPos.x + 14}px`, top: `${tooltipPos.y + 14}px` }}>
            <div className="tooltip-title">{hoveredSong.track || 'Unknown Track'}</div>
            <div className="tooltip-artist">{hoveredSong.artist || 'Unknown Artist'}</div>
            {hoveredCluster && <div className="tooltip-artist"><i className="constellation-tooltip__dot" style={{ background: clusterColor(hoveredCluster.clusterId) }} />{hoveredCluster.label}</div>}
            <div className="tooltip-action-hint"><Play size={12} style={{ marginRight: 4 }} />{onAddToQueue ? 'Click to play · Shift-click to queue' : 'Click to play'}</div>
          </div>
        )}
      </div>
    </div>
  );
}
