import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Flame, Gauge, Hand, ListPlus, LocateFixed, Navigation, Play, Rotate3d, SlidersHorizontal, Sparkles } from 'lucide-react';
import {
  buildGalaxy,
  computeGalaxyTasteOverlay,
  describeGalaxyTrackAndTransition,
} from '../../services/galaxyService.js';
import { getSongGenres, getSongMoods } from '../../services/exploreService.js';

const MAX_CLUSTER_SONGS = 5000;
const CLUSTER_COLORS = ['#78a7ff', '#c48cff', '#55d6be', '#ffb86b', '#ff7f9f', '#e7df78', '#74d99f', '#a7a7ff'];
const HIT_RADIUS_PX = 28;
// Points sit inside the unit sphere; at nearest depth perspective magnifies by 2.7 / 1.7.
const MAP_SCALE = 0.34;
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 8.0;
const MAX_PAN = 3.5;
const clampZoom = value => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
const clampPan = value => Math.max(-MAX_PAN, Math.min(MAX_PAN, value));
const PERF_STORAGE_KEY = 'sisic_galaxy_perf';

const PERF_PRESETS = Object.freeze({
  eco: { label: 'Eco (0% idle)', fps: 0, dprCap: 1, simple: 1 },
  balanced: { label: '30 fps', fps: 30, dprCap: 1.25, simple: 0 },
  full: { label: '60 fps', fps: 60, dprCap: 2, simple: 0 },
});

const STATUS_META = Object.freeze({
  playing: { label: 'Now playing', tone: 'playing' },
  rising: { label: 'Rising interest', tone: 'rising' },
  core: { label: 'Active taste', tone: 'core' },
  fading: { label: 'Drifting / muted', tone: 'fading' },
  skipped: { label: 'Skipped often', tone: 'fading' },
  dim: { label: 'Unfocused', tone: 'dim' },
});

const clusterColor = clusterId => CLUSTER_COLORS[clusterId % CLUSTER_COLORS.length];

function readInitialPerfMode() {
  try {
    const saved = window.localStorage?.getItem(PERF_STORAGE_KEY);
    if (saved && PERF_PRESETS[saved]) return saved;
  } catch { /* ignore storage restrictions */ }
  return 'balanced';
}

function buildCurvedArcVertices(fromPoint, toPoint, segments = 20) {
  if (!fromPoint || !toPoint || fromPoint.songKey === toPoint.songKey) return new Float32Array(0);
  const verts = new Float32Array((segments + 1) * 3);
  const progress = new Float32Array(segments + 1);
  const mx = (fromPoint.x + toPoint.x) * 0.5;
  const my = (fromPoint.y + toPoint.y) * 0.5;
  const mz = (fromPoint.z + toPoint.z) * 0.5;
  const dist = Math.hypot(toPoint.x - fromPoint.x, toPoint.y - fromPoint.y, toPoint.z - fromPoint.z);
  const norm = Math.hypot(mx, my, mz) || 1;
  const lift = Math.min(0.45, dist * 0.28);
  const cx = mx + (mx / norm) * lift;
  const cy = my + (my / norm) * lift + lift * 0.35;
  const cz = mz + (mz / norm) * lift;

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const inv = 1 - t;
    verts[i * 3] = inv * inv * fromPoint.x + 2 * inv * t * cx + t * t * toPoint.x;
    verts[i * 3 + 1] = inv * inv * fromPoint.y + 2 * inv * t * cy + t * t * toPoint.y;
    verts[i * 3 + 2] = inv * inv * fromPoint.z + 2 * inv * t * cz + t * t * toPoint.z;
    progress[i] = t;
  }
  return { verts, progress, count: segments + 1 };
}

// Matches the vertex shader: subtracts cameraOffset in world space, rotates, then projects (first-person POV or overview).
function screenPosition(point, width, height, zoom, rotation, camOffset, pan = { x: 0, y: 0 }, pov = false) {
  const lx = point.x - camOffset.x;
  const ly = point.y - camOffset.y;
  const lz = point.z - camOffset.z;
  const cosY = Math.cos(rotation.y);
  const sinY = Math.sin(rotation.y);
  const rotatedX = lx * cosY - lz * sinY;
  const rotatedZ = lx * sinY + lz * cosY;
  const cosX = Math.cos(rotation.x);
  const sinX = Math.sin(rotation.x);
  const rotatedY = ly * cosX - rotatedZ * sinX;
  const finalZ = ly * sinX + rotatedZ * cosX;
  if (pov) {
    if (finalZ <= 0.04) return null;
    const scale = (Math.min(width, height) * 0.5 * 1.15 * zoom) / finalZ;
    const panDepth = Math.max(0.2, finalZ);
    return {
      x: (width / 2) + (rotatedX + (pan?.x || 0) * panDepth) * scale,
      y: (height / 2) - (rotatedY + (pan?.y || 0) * panDepth) * scale,
      depth: finalZ,
    };
  }
  const perspective = 2.7 / (2.7 + finalZ);
  const scale = Math.min(width, height) * MAP_SCALE * zoom * perspective;
  return {
    x: (width / 2) + (rotatedX + (pan?.x || 0)) * scale,
    y: (height / 2) - (rotatedY + (pan?.y || 0)) * scale,
    depth: finalZ,
  };
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

function createProgram(gl, vertexSrc, fragmentSrc) {
  const vertex = shader(gl, gl.VERTEX_SHADER, vertexSrc);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    throw new Error('WebGL program failed to link.');
  }
  return program;
}

const SHARED_PROJECTION = `
  vec4 projectStar(vec3 pos, vec3 camOffset, vec2 pan, float rx, float ry, float zoom, float aspect, float pov) {
    vec3 l = pos - camOffset;
    float cosY = cos(ry);
    float sinY = sin(ry);
    vec3 p = vec3(l.x * cosY - l.z * sinY, l.y, l.x * sinY + l.z * cosY);
    float cosX = cos(rx);
    float sinX = sin(rx);
    p = vec3(p.x, p.y * cosX - p.z * sinX, p.y * sinX + p.z * cosX);
    if (pov > 0.5) {
      float depth = p.z;
      vec2 shifted = vec2(p.x + pan.x * max(0.2, depth), p.y + pan.y * max(0.2, depth));
      return vec4(
        shifted.x * 1.15 * zoom * min(1.0, 1.0 / aspect),
        shifted.y * 1.15 * zoom * min(1.0, aspect),
        depth * 0.8 - 0.08,
        depth
      );
    }
    float perspective = 2.7 / (2.7 + p.z);
    float s = perspective * zoom * ${(MAP_SCALE * 2).toFixed(3)};
    vec2 shifted = vec2(p.x + pan.x, p.y + pan.y);
    return vec4(shifted.x * s * min(1.0, 1.0 / aspect), shifted.y * s * min(1.0, aspect), p.z * 0.2, perspective);
  }
`;

function createPointProgram(gl) {
  return createProgram(
    gl,
    `
      attribute vec3 a_position;
      attribute vec3 a_color;
      attribute float a_size;
      attribute float a_cluster;
      attribute float a_focus;
      attribute float a_delta;
      attribute float a_current;
      attribute float a_in_category;
      uniform vec3 u_camera_offset;
      uniform vec2 u_pan;
      uniform float u_rotation_x;
      uniform float u_rotation_y;
      uniform float u_zoom;
      uniform float u_aspect;
      uniform float u_pov;
      uniform float u_focus;
      uniform float u_has_category;
      uniform float u_mode;
      uniform float u_time;
      uniform float u_simple;
      varying vec3 v_color;
      varying float v_alpha;
      varying float v_glow;
      varying float v_current;
      varying float v_simple;
      ${SHARED_PROJECTION}
      void main() {
        vec4 proj = projectStar(a_position, u_camera_offset, u_pan, u_rotation_x, u_rotation_y, u_zoom, u_aspect, u_pov);
        if (u_pov > 0.5 && proj.w <= 0.04) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          gl_PointSize = 0.0;
          return;
        }
        gl_Position = u_pov > 0.5 ? proj : vec4(proj.xyz, 1.0);
        float perspective = u_pov > 0.5
          ? clamp(1.15 / max(0.05, proj.w), 0.4, 2.4)
          : clamp(proj.w, 0.35, 2.2);
        bool clusterMuted = (u_focus >= 0.0 && abs(a_cluster - u_focus) > 0.5)
          || (u_has_category > 0.5 && a_in_category < 0.5);
        float twinkle = u_simple > 0.5 ? 1.0 : (1.0 + 0.14 * sin(u_time * 2.4 + a_position.x * 11.0 + a_position.z * 7.0));
        float focusCurve = smoothstep(0.14, 0.94, a_focus);

        vec3 baseColor = a_color;
        float alpha = 0.9;
        float sizeScale = 1.0;
        float glow = 0.55;

        if (u_mode < 0.5) {
          alpha = mix(0.11, 1.0, focusCurve);
          sizeScale = mix(0.58, 1.48, focusCurve) * (a_focus > 0.66 ? twinkle : 1.0);
          glow = mix(0.22, 0.92, focusCurve);
          vec3 mutedTone = vec3(0.26, 0.31, 0.48);
          baseColor = mix(mutedTone, a_color, mix(0.32, 1.0, focusCurve));
          if (a_delta > 0.24) {
            baseColor = mix(baseColor, vec3(1.0, 0.84, 0.46), 0.35 * focusCurve);
          }
        } else if (u_mode < 1.5) {
          float rise = smoothstep(0.12, 0.85, a_delta);
          float fade = smoothstep(-0.12, -0.85, a_delta);
          vec3 risingColor = vec3(1.0, 0.78, 0.34);
          vec3 coreColor = vec3(0.45, 0.91, 1.0);
          vec3 fadeColor = vec3(0.28, 0.33, 0.56);
          baseColor = mix(coreColor, risingColor, rise);
          baseColor = mix(baseColor, fadeColor, fade * 0.85 + (1.0 - focusCurve) * 0.45);
          float shiftEnergy = max(rise, focusCurve * (1.0 - fade) * 0.78);
          alpha = mix(0.11, 1.0, shiftEnergy);
          sizeScale = mix(0.56, 1.62, max(rise, focusCurve * 0.7)) * (rise > 0.35 ? twinkle : 1.0);
          glow = mix(0.2, 0.98, max(rise, focusCurve * 0.75));
        }

        if (clusterMuted) {
          alpha *= 0.14;
          sizeScale *= 0.65;
          glow *= 0.3;
        }
        if (a_current > 0.5) {
          alpha = 1.0;
          sizeScale = 1.38 + (u_simple > 0.5 ? 0.0 : 0.18 * sin(u_time * 3.4));
          glow = 1.0;
          baseColor = vec3(1.0);
        }

        gl_PointSize = a_size * (0.76 + perspective * 0.86) * sizeScale * (u_simple > 0.5 ? 0.82 : 1.15);
        v_color = baseColor;
        v_alpha = alpha;
        v_glow = glow;
        v_current = a_current;
        v_simple = u_simple;
      }
    `,
    `
      precision mediump float;
      varying vec3 v_color;
      varying float v_alpha;
      varying float v_glow;
      varying float v_current;
      varying float v_simple;
      void main() {
        vec2 p = gl_PointCoord - vec2(0.5);
        float edge = length(p);
        if (edge > 0.5) discard;
        if (v_simple > 0.5) {
          float disc = 1.0 - smoothstep(0.25, 0.5, edge);
          gl_FragColor = vec4(v_color, disc * v_alpha);
          return;
        }
        float core = 1.0 - smoothstep(0.05, 0.17, edge);
        float halo = exp(-edge * 5.2) * (0.58 + 0.55 * v_glow);
        float spikeH = exp(-abs(p.y) * 26.0) * exp(-abs(p.x) * 6.5);
        float spikeV = exp(-abs(p.x) * 26.0) * exp(-abs(p.y) * 6.5);
        float flare = (spikeH + spikeV) * smoothstep(0.42, 1.0, v_glow) * 0.68;
        float ring = v_current > 0.5 ? (1.0 - smoothstep(0.0, 0.055, abs(edge - 0.36))) * 0.85 : 0.0;
        float intensity = clamp(max(core, max(halo, ring)) + flare, 0.0, 1.0);
        vec3 col = mix(v_color, vec3(1.0), clamp(core * 0.48 + flare * 0.55 + ring * 0.5, 0.0, 0.92));
        gl_FragColor = vec4(col, clamp(intensity * v_alpha, 0.0, 1.0));
      }
    `,
  );
}

function createEdgeProgram(gl) {
  return createProgram(
    gl,
    `
      attribute vec3 a_position;
      attribute float a_strength;
      uniform vec3 u_camera_offset;
      uniform vec2 u_pan;
      uniform float u_rotation_x;
      uniform float u_rotation_y;
      uniform float u_zoom;
      uniform float u_aspect;
      uniform float u_pov;
      uniform vec3 u_line_color;
      uniform float u_progress;
      varying float v_strength;
      varying float v_t;
      varying vec3 v_color;
      varying float v_progress;
      ${SHARED_PROJECTION}
      void main() {
        vec4 proj = projectStar(a_position, u_camera_offset, u_pan, u_rotation_x, u_rotation_y, u_zoom, u_aspect, u_pov);
        gl_Position = u_pov > 0.5 ? proj : vec4(proj.xyz, 1.0);
        v_strength = a_strength;
        v_t = a_strength;
        v_color = u_line_color;
        v_progress = u_progress;
      }
    `,
    `
      precision mediump float;
      varying float v_strength;
      varying float v_t;
      varying vec3 v_color;
      varying float v_progress;
      void main() {
        float vis = v_progress < 0.0 ? v_strength * 0.34 : smoothstep(v_t - 0.08, v_t, v_progress) * 0.92;
        if (v_progress >= 0.0 && v_t > v_progress) discard;
        gl_FragColor = vec4(v_color, vis);
      }
    `,
  );
}

export function ConstellationView({
  songs = [],
  gemmaVectors = null,
  playbackEvents = [],
  likedSongKeys = [],
  currentSong,
  isQueueOpen = false,
  onPlaySong,
  onAddToQueue,
  onPlayCluster,
}) {
  const canvasRef = useRef(null);
  const wrapperRef = useRef(null);
  const popoverRef = useRef(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const rotationRef = useRef({ x: 0.08, y: 0.0 });
  const targetRotYRef = useRef(null);
  const targetRotXRef = useRef(null);
  const camCurrentRef = useRef({ x: 0, y: 0, z: -0.35 });
  const camTargetRef = useRef({ x: 0, y: 0, z: -0.35 });
  const povRef = useRef(true);
  const panRef = useRef({ x: 0, y: 0 });
  const panTargetRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const targetZoomRef = useRef(1);
  const dragModeRef = useRef('orbit');
  const spacePressedRef = useRef(false);
  const activePointersRef = useRef(new Map());
  const pinchRef = useRef(null);
  const zoomSyncRafRef = useRef(0);
  const focusRef = useRef(-1);
  const categoryRef = useRef('');
  const categorySetRef = useRef(null);
  const categoryBufferRef = useRef(null);
  const modeRef = useRef(0);
  const perfRef = useRef('balanced');
  const pathProgressRef = useRef(1);
  const dragRef = useRef(null);
  const redrawRef = useRef(() => {});
  const movedRef = useRef(false);
  const songTrackerRef = useRef({ prevKey: '', currentKey: '' });

  const [hoveredSong, setHoveredSong] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragMode, setDragMode] = useState('orbit');
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [isPanDragging, setIsPanDragging] = useState(false);
  const [filterMode, setFilterMode] = useState('all');
  const [highlightMode, setHighlightMode] = useState('focus'); // 'focus' | 'shift' | 'all'
  const [hoveredClusterId, setHoveredClusterId] = useState(-1);
  const [selectedClusterId, setSelectedClusterId] = useState(-1);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [followPlaying, setFollowPlaying] = useState(true);
  const [povMode, setPovMode] = useState(true);
  const [perfMode, setPerfMode] = useState(readInitialPerfMode);
  const [prevTrackKey, setPrevTrackKey] = useState('');
  const [webglReady, setWebglReady] = useState(true);
  const effectivePopoverOpen = popoverOpen && !isQueueOpen;

  useEffect(() => {
    if (!effectivePopoverOpen) return undefined;
    const handlePointerDown = event => {
      if (popoverRef.current && !popoverRef.current.contains(event.target)) {
        setPopoverOpen(false);
      }
    };
    const handleKeyDown = event => {
      if (event.key === 'Escape') setPopoverOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [effectivePopoverOpen]);

  const activeFocusCluster = selectedClusterId >= 0 ? selectedClusterId : hoveredClusterId;
  const readyCount = useMemo(() => songs.filter(song => song.driveFileId).length, [songs]);
  const filteredSongs = useMemo(() => {
    const filtered = filterMode === 'ready' ? songs.filter(song => song.driveFileId) : songs;
    if (filtered.length <= MAX_CLUSTER_SONGS) return filtered;
    const limited = filtered.slice(0, MAX_CLUSTER_SONGS);
    if (currentSong && !limited.some(song => song.songKey === currentSong.songKey)) limited[limited.length - 1] = currentSong;
    return limited;
  }, [currentSong, filterMode, songs]);

  const galaxy = useMemo(
    () => buildGalaxy(filteredSongs, { preference: 'auto', gemmaVectors }),
    [filteredSongs, gemmaVectors],
  );
  const { points, clusters } = galaxy;
  const clusterById = useMemo(() => new Map(clusters.map(cluster => [cluster.clusterId, cluster])), [clusters]);

  const categories = useMemo(() => {
    const groups = new Map();
    for (const point of points) {
      const labels = new Set(
        [...getSongGenres(point), ...getSongMoods(point)]
          .filter(label => label && label !== 'Open format' && label !== 'Discovery'),
      );
      for (const label of labels) {
        if (!groups.has(label)) groups.set(label, { label, songs: [], keys: new Set() });
        const entry = groups.get(label);
        entry.songs.push(point);
        entry.keys.add(point.songKey);
      }
    }
    return [...groups.values()]
      .filter(entry => entry.songs.length >= 2)
      .sort((a, b) => b.songs.length - a.songs.length)
      .slice(0, 12);
  }, [points]);

  const selectedCategoryObj = useMemo(
    () => (selectedCategory ? categories.find(c => c.label === selectedCategory) || null : null),
    [categories, selectedCategory],
  );

  // Track previous playing song smoothly whenever currentSong changes.
  useEffect(() => {
    const nextKey = currentSong?.songKey || '';
    if (!nextKey || nextKey === songTrackerRef.current.currentKey) return;
    if (songTrackerRef.current.currentKey) {
      setPrevTrackKey(songTrackerRef.current.currentKey);
      songTrackerRef.current.prevKey = songTrackerRef.current.currentKey;
      pathProgressRef.current = 0;
    }
    songTrackerRef.current.currentKey = nextKey;
  }, [currentSong?.songKey]);

  const currentPoint = useMemo(
    () => points.find(point => point.songKey === currentSong?.songKey) || null,
    [currentSong?.songKey, points],
  );
  const prevPoint = useMemo(
    () => (prevTrackKey ? points.find(point => point.songKey === prevTrackKey) || null : null),
    [points, prevTrackKey],
  );
  const currentCluster = currentPoint && clusterById.get(currentPoint.clusterId);

  const tasteOverlay = useMemo(() => computeGalaxyTasteOverlay(points, {
    mode: galaxy.mode,
    gemmaVectors,
    playbackEvents,
    likedSongKeys,
    currentSong,
  }), [currentSong, galaxy.mode, gemmaVectors, likedSongKeys, playbackEvents, points]);

  const trackProfile = useMemo(() => describeGalaxyTrackAndTransition(currentPoint, {
    prevPoint,
    cluster: currentCluster,
    gemmaVectors,
  }), [currentCluster, currentPoint, gemmaVectors, prevPoint]);

  const topGlowingSongs = useMemo(() => {
    const scope = points.filter(song => song.driveFileId
      && song.songKey !== currentSong?.songKey
      && (selectedClusterId < 0 || song.clusterId === selectedClusterId));
    return [...scope]
      .sort((a, b) => {
        const ma = tasteOverlay.metricsByKey.get(a.songKey);
        const mb = tasteOverlay.metricsByKey.get(b.songKey);
        const keyA = highlightMode === 'shift' ? (ma?.delta ?? 0) : (ma?.focus ?? 0);
        const keyB = highlightMode === 'shift' ? (mb?.delta ?? 0) : (mb?.focus ?? 0);
        return keyB - keyA;
      })
      .slice(0, 5);
  }, [currentSong?.songKey, highlightMode, points, selectedClusterId, tasteOverlay.metricsByKey]);

  const transitionArc = useMemo(
    () => buildCurvedArcVertices(prevPoint, currentPoint, 22),
    [currentPoint, prevPoint],
  );

  useEffect(() => {
    povRef.current = povMode;
    redrawRef.current();
  }, [povMode]);

  // Fly camera in 3D space toward current song (or selected cluster centroid when isolated).
  useEffect(() => {
    const computePovPose = (target, standoff) => {
      const len = Math.hypot(target.x, target.y, target.z);
      const dir = len > 0.05
        ? { x: target.x / len, y: target.y / len, z: target.z / len }
        : { x: 0, y: 0, z: 1 };
      return {
        eye: {
          x: target.x - dir.x * standoff,
          y: target.y - dir.y * standoff,
          z: target.z - dir.z * standoff,
        },
        rotY: Math.atan2(dir.x, dir.z),
        rotX: Math.atan2(dir.y, Math.hypot(dir.x, dir.z)),
      };
    };

    const focusGroupPoints = selectedClusterId >= 0
      ? (clusterById.get(selectedClusterId)?.songs || [])
      : (selectedCategoryObj?.songs || []);
    if (focusGroupPoints.length) {
      let sx = 0; let sy = 0; let sz = 0;
      for (const p of focusGroupPoints) { sx += p.x; sy += p.y; sz += p.z; }
      const n = focusGroupPoints.length;
      const centroid = { x: sx / n, y: sy / n, z: sz / n };
      if (povMode) {
        const pose = computePovPose(centroid, 0.42);
        camTargetRef.current = pose.eye;
        targetRotYRef.current = pose.rotY;
        targetRotXRef.current = pose.rotX;
        targetZoomRef.current = 1.05;
      } else {
        camTargetRef.current = { x: centroid.x * 0.45, y: centroid.y * 0.45, z: centroid.z * 0.45 };
        targetRotYRef.current = -Math.atan2(centroid.x, centroid.z);
        targetRotXRef.current = null;
        targetZoomRef.current = 1.25;
      }
      redrawRef.current();
      return;
    }
    if (followPlaying && currentPoint) {
      if (povMode) {
        const pose = computePovPose(currentPoint, 0.36);
        camTargetRef.current = pose.eye;
        targetRotYRef.current = pose.rotY;
        targetRotXRef.current = pose.rotX;
        targetZoomRef.current = 1.0;
      } else {
        camTargetRef.current = { x: currentPoint.x * 0.62, y: currentPoint.y * 0.62, z: currentPoint.z * 0.62 };
        targetRotYRef.current = -Math.atan2(currentPoint.x, currentPoint.z);
        targetRotXRef.current = null;
        targetZoomRef.current = Math.max(zoomRef.current, 1.38);
      }
      redrawRef.current();
    } else if (!followPlaying && selectedClusterId < 0 && !selectedCategoryObj) {
      camTargetRef.current = povMode ? { x: 0, y: 0, z: -0.35 } : { x: 0, y: 0, z: 0 };
      targetRotYRef.current = povMode ? 0 : null;
      targetRotXRef.current = povMode ? 0.08 : null;
      redrawRef.current();
    }
  }, [clusterById, currentPoint, followPlaying, povMode, selectedCategoryObj, selectedClusterId]);

  const modeNumeric = highlightMode === 'focus' ? 0 : highlightMode === 'shift' ? 1 : 2;
  useEffect(() => {
    perfRef.current = perfMode;
    try { window.localStorage?.setItem(PERF_STORAGE_KEY, perfMode); } catch { /* ignore */ }
    redrawRef.current();
  }, [perfMode]);

  // Adjust canvas resolution when DPR budget changes cleanly with perfMode.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    const updateSize = () => {
      const canvas = canvasRef.current;
      if (!canvas || !wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const cap = PERF_PRESETS[perfMode]?.dprCap ?? 1.25;
      const pixelRatio = Math.min(cap, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
      redrawRef.current();
    };
    updateSize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateSize) : null;
    if (observer && wrapper) observer.observe(wrapper);
    else window.addEventListener('resize', updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [perfMode]);

  useEffect(() => {
    dragModeRef.current = dragMode;
    redrawRef.current();
  }, [dragMode]);

  useEffect(() => () => {
    if (zoomSyncRafRef.current) window.cancelAnimationFrame(zoomSyncRafRef.current);
  }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;

    const handleWheel = event => {
      if (event.target?.closest?.('.constellation-popover__panel, .constellation-track-hud, .constellation-next-path')) {
        return;
      }
      event.preventDefault();
      const lineFactor = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? 240 : 1;
      const rawDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      const dy = rawDelta * lineFactor;
      if (!dy) return;

      const rect = wrapper.getBoundingClientRect();
      const minDim = Math.max(1, Math.min(rect.width, rect.height));
      const cx = (event.clientX - rect.left) - rect.width / 2;
      const cy = -((event.clientY - rect.top) - rect.height / 2);

      const oldZoom = zoomRef.current;
      const sensitivity = event.ctrlKey ? 0.01 : 0.0022;
      const nextZoom = clampZoom(oldZoom * Math.exp(-dy * sensitivity));
      if (Math.abs(nextZoom - oldZoom) < 0.0004) return;

      const invDelta = (1 / nextZoom) - (1 / oldZoom);
      const nextPan = {
        x: clampPan(panRef.current.x + (cx / (minDim * MAP_SCALE)) * invDelta),
        y: clampPan(panRef.current.y + (cy / (minDim * MAP_SCALE)) * invDelta),
      };
      panRef.current = nextPan;
      panTargetRef.current = nextPan;
      zoomRef.current = nextZoom;
      targetZoomRef.current = nextZoom;
      if (!zoomSyncRafRef.current) {
        zoomSyncRafRef.current = window.requestAnimationFrame(() => {
          zoomSyncRafRef.current = 0;
          setZoom(+zoomRef.current.toFixed(2));
        });
      }
      redrawRef.current();
    };

    const isTypingTarget = target => {
      const tag = target?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;
    };

    const handleKeyDown = event => {
      if (isTypingTarget(event.target)) return;
      if (event.code === 'Space' && !spacePressedRef.current) {
        spacePressedRef.current = true;
        setSpacePanActive(true);
        if (wrapper.contains(document.activeElement)) event.preventDefault();
        return;
      }
      if (!wrapper.contains(document.activeElement)) return;
      const panStep = 0.14 / Math.max(0.5, zoomRef.current);
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        panTargetRef.current = { ...panTargetRef.current, x: clampPan(panTargetRef.current.x + panStep) };
        redrawRef.current();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        panTargetRef.current = { ...panTargetRef.current, x: clampPan(panTargetRef.current.x - panStep) };
        redrawRef.current();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        panTargetRef.current = { ...panTargetRef.current, y: clampPan(panTargetRef.current.y - panStep) };
        redrawRef.current();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        panTargetRef.current = { ...panTargetRef.current, y: clampPan(panTargetRef.current.y + panStep) };
        redrawRef.current();
      }
    };

    const handleKeyUp = event => {
      if (event.code === 'Space') {
        spacePressedRef.current = false;
        setSpacePanActive(false);
      }
    };

    wrapper.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      wrapper.removeEventListener('wheel', handleWheel);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  useEffect(() => { focusRef.current = activeFocusCluster; redrawRef.current(); }, [activeFocusCluster]);
  useEffect(() => {
    categoryRef.current = selectedCategoryObj?.label || '';
    categorySetRef.current = selectedCategoryObj?.keys || null;
    const ref = categoryBufferRef.current;
    if (ref?.gl && ref?.buffer && points.length) {
      const catData = new Float32Array(points.length);
      const keys = categorySetRef.current;
      for (let i = 0; i < points.length; i++) {
        catData[i] = !keys || keys.has(points[i].songKey) ? 1 : 0;
      }
      ref.gl.bindBuffer(ref.gl.ARRAY_BUFFER, ref.buffer);
      ref.gl.bufferData(ref.gl.ARRAY_BUFFER, catData, ref.gl.DYNAMIC_DRAW);
    }
    redrawRef.current();
  }, [points, selectedCategoryObj]);
  useEffect(() => { modeRef.current = modeNumeric; redrawRef.current(); }, [modeNumeric]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return undefined;
    let gl;
    try {
      gl = canvas.getContext('webgl', { alpha: true, antialias: false, powerPreference: 'low-power' });
      if (!gl) throw new Error('WebGL is unavailable.');
      const program = createPointProgram(gl);
      const edgeProgram = createEdgeProgram(gl);
      const pointBuffers = [];
      const edgeBuffers = [];
      const arcBuffers = [];

      const bindInto = (targetProgram, bufferList, name, data, size) => {
        const location = gl.getAttribLocation(targetProgram, name);
        if (location < 0) return null;
        const buffer = gl.createBuffer();
        bufferList.push({ buffer, location, size });
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        return buffer;
      };

      const enableAttribs = (bufferList) => {
        for (const item of bufferList) {
          gl.bindBuffer(gl.ARRAY_BUFFER, item.buffer);
          gl.enableVertexAttribArray(item.location);
          gl.vertexAttribPointer(item.location, item.size, gl.FLOAT, false, 0, 0);
        }
      };

      const pointUniforms = Object.fromEntries(
        ['u_camera_offset', 'u_pan', 'u_rotation_x', 'u_rotation_y', 'u_zoom', 'u_aspect', 'u_pov', 'u_focus', 'u_has_category', 'u_mode', 'u_time', 'u_simple']
          .map(name => [name, gl.getUniformLocation(program, name)]),
      );
      const edgeUniforms = Object.fromEntries(
        ['u_camera_offset', 'u_pan', 'u_rotation_x', 'u_rotation_y', 'u_zoom', 'u_aspect', 'u_pov', 'u_line_color', 'u_progress']
          .map(name => [name, gl.getUniformLocation(edgeProgram, name)]),
      );

      const isCurrent = point => point.songKey === currentSong?.songKey;
      const clusterSizes = new Map(clusters.map(cluster => [cluster.clusterId, cluster.songs.length]));
      const posData = new Float32Array(points.length * 3);
      const colorData = new Float32Array(points.length * 3);
      const sizeData = new Float32Array(points.length);
      const clusterData = new Float32Array(points.length);
      const focusData = new Float32Array(points.length);
      const deltaData = new Float32Array(points.length);
      const currentData = new Float32Array(points.length);
      const catData = new Float32Array(points.length);
      const activeKeys = categorySetRef.current;

      for (let i = 0; i < points.length; i++) {
        const point = points[i];
        const cur = isCurrent(point);
        const metric = tasteOverlay.metricsByKey.get(point.songKey);
        const color = clusterColor(point.clusterId);
        posData[i * 3] = point.x;
        posData[i * 3 + 1] = point.y;
        posData[i * 3 + 2] = point.z;
        colorData[i * 3] = cur ? 1 : parseInt(color.slice(1, 3), 16) / 255;
        colorData[i * 3 + 1] = cur ? 1 : parseInt(color.slice(3, 5), 16) / 255;
        colorData[i * 3 + 2] = cur ? 1 : parseInt(color.slice(5, 7), 16) / 255;
        sizeData[i] = cur ? 18 : 7.5 + Math.min(7, (clusterSizes.get(point.clusterId) || 0) / 140);
        clusterData[i] = point.clusterId;
        focusData[i] = metric?.focus ?? 0.65;
        deltaData[i] = metric?.delta ?? 0;
        currentData[i] = cur ? 1 : 0;
        catData[i] = !activeKeys || activeKeys.has(point.songKey) ? 1 : 0;
      }

      bindInto(program, pointBuffers, 'a_position', posData, 3);
      bindInto(program, pointBuffers, 'a_color', colorData, 3);
      bindInto(program, pointBuffers, 'a_size', sizeData, 1);
      bindInto(program, pointBuffers, 'a_cluster', clusterData, 1);
      bindInto(program, pointBuffers, 'a_focus', focusData, 1);
      bindInto(program, pointBuffers, 'a_delta', deltaData, 1);
      bindInto(program, pointBuffers, 'a_current', currentData, 1);
      const catBuffer = bindInto(program, pointBuffers, 'a_in_category', catData, 1);
      categoryBufferRef.current = catBuffer ? { gl, buffer: catBuffer } : null;

      const edges = tasteOverlay.edges || [];
      if (edges.length) {
        const edgePos = new Float32Array(edges.length * 6);
        const edgeStrength = new Float32Array(edges.length * 2);
        edges.forEach(([aIdx, bIdx, strength], e) => {
          const pa = points[aIdx];
          const pb = points[bIdx];
          if (!pa || !pb) return;
          edgePos.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], e * 6);
          edgeStrength.set([strength, strength * 0.45], e * 2);
        });
        bindInto(edgeProgram, edgeBuffers, 'a_position', edgePos, 3);
        bindInto(edgeProgram, edgeBuffers, 'a_strength', edgeStrength, 1);
      }

      const arcCount = transitionArc?.count || 0;
      if (arcCount > 1) {
        bindInto(edgeProgram, arcBuffers, 'a_position', transitionArc.verts, 3);
        bindInto(edgeProgram, arcBuffers, 'a_strength', transitionArc.progress, 1);
      }

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0.022, 0.028, 0.062, 1);

      let frame;
      let previousTime;
      let lastDrawTime = -Infinity;
      const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

      const render = (time = performance.now()) => {
        frame = 0;
        if (document.hidden) { previousTime = undefined; return; }

        const preset = PERF_PRESETS[perfRef.current] || PERF_PRESETS.balanced;
        const minFrameMs = preset.fps > 0 ? (1000 / preset.fps) : 0;
        const dtSec = previousTime !== undefined ? Math.min(0.08, (time - previousTime) / 1000) : 0.016;
        previousTime = time;

        // Smooth camera flight through 3D space toward current song/cluster target & 2D pan reset.
        const step = motion.matches ? 1 : 1 - Math.exp(-dtSec * 3.4);
        const curCam = camCurrentRef.current;
        const tgtCam = camTargetRef.current;
        const camDist = Math.hypot(tgtCam.x - curCam.x, tgtCam.y - curCam.y, tgtCam.z - curCam.z);
        curCam.x += (tgtCam.x - curCam.x) * step;
        curCam.y += (tgtCam.y - curCam.y) * step;
        curCam.z += (tgtCam.z - curCam.z) * step;

        const curPan = panRef.current;
        const tgtPan = panTargetRef.current;
        const panDist = Math.hypot(tgtPan.x - curPan.x, tgtPan.y - curPan.y);
        if (panDist > 0.0005) {
          curPan.x += (tgtPan.x - curPan.x) * step;
          curPan.y += (tgtPan.y - curPan.y) * step;
        } else {
          curPan.x = tgtPan.x;
          curPan.y = tgtPan.y;
        }

        let zoomMoving = false;
        if (Math.abs(targetZoomRef.current - zoomRef.current) > 0.004) {
          zoomRef.current += (targetZoomRef.current - zoomRef.current) * step;
          zoomMoving = true;
        }
        const isCloseInspect = povRef.current || zoomRef.current > 1.35 || Math.hypot(curPan.x, curPan.y) > 0.06 || dragModeRef.current === 'pan';
        let rotMoving = false;
        if (!dragRef.current && targetRotYRef.current !== null) {
          const diffY = Math.atan2(
            Math.sin(targetRotYRef.current - rotationRef.current.y),
            Math.cos(targetRotYRef.current - rotationRef.current.y),
          );
          if (Math.abs(diffY) > 0.004) {
            rotationRef.current.y += diffY * step;
            rotMoving = true;
          }
        } else if (!dragRef.current && !isCloseInspect && !motion.matches && preset.fps > 0) {
          rotationRef.current.y += dtSec * 0.068;
        }
        if (!dragRef.current && targetRotXRef.current !== null) {
          const diffX = targetRotXRef.current - rotationRef.current.x;
          if (Math.abs(diffX) > 0.004) {
            rotationRef.current.x += diffX * step;
            rotMoving = true;
          }
        }
        const pathMoving = arcCount > 1 && pathProgressRef.current < 1;
        if (pathMoving) {
          pathProgressRef.current = motion.matches ? 1 : Math.min(1, pathProgressRef.current + dtSec * 0.85);
        }

        const flightActive = camDist > 0.003 || panDist > 0.001 || zoomMoving || rotMoving || pathMoving;
        const shouldDraw = !minFrameMs || (time - lastDrawTime >= minFrameMs - 1) || flightActive;

        if (shouldDraw) {
          lastDrawTime = time;
          const width = canvas.width;
          const height = canvas.height;
          const aspect = width / Math.max(1, height);
          const povValue = povRef.current ? 1.0 : 0.0;
          gl.viewport(0, 0, width, height);
          gl.clear(gl.COLOR_BUFFER_BIT);

          if (edges.length && modeRef.current !== 2) {
            gl.useProgram(edgeProgram);
            enableAttribs(edgeBuffers);
            gl.uniform3f(edgeUniforms.u_camera_offset, curCam.x, curCam.y, curCam.z);
            gl.uniform2f(edgeUniforms.u_pan, curPan.x, curPan.y);
            gl.uniform1f(edgeUniforms.u_rotation_x, rotationRef.current.x);
            gl.uniform1f(edgeUniforms.u_rotation_y, rotationRef.current.y);
            gl.uniform1f(edgeUniforms.u_zoom, zoomRef.current);
            gl.uniform1f(edgeUniforms.u_aspect, aspect);
            gl.uniform1f(edgeUniforms.u_pov, povValue);
            gl.uniform3f(edgeUniforms.u_line_color, 0.45, 0.86, 1.0);
            gl.uniform1f(edgeUniforms.u_progress, -1.0);
            gl.drawArrays(gl.LINES, 0, edges.length * 2);
          }

          if (arcCount > 1) {
            gl.useProgram(edgeProgram);
            enableAttribs(arcBuffers);
            gl.uniform3f(edgeUniforms.u_camera_offset, curCam.x, curCam.y, curCam.z);
            gl.uniform2f(edgeUniforms.u_pan, curPan.x, curPan.y);
            gl.uniform1f(edgeUniforms.u_rotation_x, rotationRef.current.x);
            gl.uniform1f(edgeUniforms.u_rotation_y, rotationRef.current.y);
            gl.uniform1f(edgeUniforms.u_zoom, zoomRef.current);
            gl.uniform1f(edgeUniforms.u_aspect, aspect);
            gl.uniform1f(edgeUniforms.u_pov, povValue);
            gl.uniform3f(edgeUniforms.u_line_color, 1.0, 0.78, 0.36);
            gl.uniform1f(edgeUniforms.u_progress, pathProgressRef.current);
            gl.drawArrays(gl.LINE_STRIP, 0, arcCount);
          }

          gl.useProgram(program);
          enableAttribs(pointBuffers);
          gl.uniform3f(pointUniforms.u_camera_offset, curCam.x, curCam.y, curCam.z);
          gl.uniform2f(pointUniforms.u_pan, curPan.x, curPan.y);
          gl.uniform1f(pointUniforms.u_rotation_x, rotationRef.current.x);
          gl.uniform1f(pointUniforms.u_rotation_y, rotationRef.current.y);
          gl.uniform1f(pointUniforms.u_zoom, zoomRef.current);
          gl.uniform1f(pointUniforms.u_aspect, aspect);
          gl.uniform1f(pointUniforms.u_pov, povValue);
          gl.uniform1f(pointUniforms.u_focus, focusRef.current);
          gl.uniform1f(pointUniforms.u_has_category, categoryRef.current ? 1.0 : 0.0);
          gl.uniform1f(pointUniforms.u_mode, modeRef.current);
          gl.uniform1f(pointUniforms.u_time, (motion.matches || preset.fps === 0) ? 0 : time * 0.001);
          gl.uniform1f(pointUniforms.u_simple, preset.simple);
          gl.drawArrays(gl.POINTS, 0, points.length);
        }

        // Eco mode only keeps looping during active 3D flight; rests at 0% GPU otherwise.
        if (!motion.matches && (preset.fps > 0 || flightActive)) {
          frame = window.requestAnimationFrame(render);
        }
      };

      const refresh = () => {
        previousTime = undefined;
        lastDrawTime = -Infinity;
        if (!frame) frame = window.requestAnimationFrame(render);
      };
      redrawRef.current = refresh;
      document.addEventListener('visibilitychange', refresh);
      motion.addEventListener('change', refresh);
      render();
      return () => {
        categoryBufferRef.current = null;
        redrawRef.current = () => {};
        document.removeEventListener('visibilitychange', refresh);
        motion.removeEventListener('change', refresh);
        if (frame) window.cancelAnimationFrame(frame);
        [...pointBuffers, ...edgeBuffers, ...arcBuffers].forEach(item => gl.deleteBuffer(item.buffer));
        gl.deleteProgram(program);
        gl.deleteProgram(edgeProgram);
      };
    } catch (error) {
      console.warn('3D constellation unavailable:', error);
      const timer = window.setTimeout(() => setWebglReady(false), 0);
      return () => window.clearTimeout(timer);
    }
  }, [clusters, currentSong?.songKey, points, tasteOverlay, transitionArc]);

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
      if (categoryRef.current && !categorySetRef.current?.has(point.songKey)) return;
      const screen = screenPosition(point, rect.width, rect.height, zoomRef.current, rotationRef.current, camCurrentRef.current, panRef.current, povRef.current);
      if (!screen) return;
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

  const stepZoom = factor => {
    const next = clampZoom(Number((targetZoomRef.current * factor).toFixed(2)));
    targetZoomRef.current = next;
    setZoom(next);
    redrawRef.current();
  };

  const resetView = () => {
    panTargetRef.current = { x: 0, y: 0 };
    camTargetRef.current = povRef.current ? { x: 0, y: 0, z: -0.35 } : { x: 0, y: 0, z: 0 };
    targetZoomRef.current = 1;
    targetRotYRef.current = povRef.current ? 0 : null;
    targetRotXRef.current = povRef.current ? 0.08 : null;
    setZoom(1);
    setSelectedClusterId(-1);
    setSelectedCategory('');
    redrawRef.current();
  };

  const handlePointerDown = event => {
    movedRef.current = false;
    targetRotYRef.current = null;
    targetRotXRef.current = null;
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointersRef.current.size === 2) {
      const [p1, p2] = [...activePointersRef.current.values()];
      pinchRef.current = {
        dist: Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
        midX: (p1.x + p2.x) / 2,
        midY: (p1.y + p2.y) / 2,
      };
      dragRef.current = null;
      setIsPanDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }

    const isPan = event.button === 1
      || event.button === 2
      || event.shiftKey
      || spacePressedRef.current
      || dragModeRef.current === 'pan';
    const mode = isPan ? 'pan' : 'orbit';
    dragRef.current = { x: event.clientX, y: event.clientY, mode };
    setIsPanDragging(mode === 'pan');
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = event => {
    if (activePointersRef.current.has(event.pointerId)) {
      activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (activePointersRef.current.size === 2 && pinchRef.current) {
      const [p1, p2] = [...activePointersRef.current.values()];
      const nextDist = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const wrapper = wrapperRef.current;
      if (wrapper) {
        const rect = wrapper.getBoundingClientRect();
        const minDim = Math.max(1, Math.min(rect.width, rect.height));
        const scaleFactor = nextDist / pinchRef.current.dist;
        const oldZoom = zoomRef.current;
        const nextZoom = clampZoom(oldZoom * scaleFactor);
        const worldPerPx = 1 / (minDim * MAP_SCALE * nextZoom);
        const dx = midX - pinchRef.current.midX;
        const dy = midY - pinchRef.current.midY;
        const cx = (midX - rect.left) - rect.width / 2;
        const cy = -((midY - rect.top) - rect.height / 2);
        const invDelta = (1 / nextZoom) - (1 / oldZoom);
        const nextPan = {
          x: clampPan(panRef.current.x + dx * worldPerPx + (cx / (minDim * MAP_SCALE)) * invDelta),
          y: clampPan(panRef.current.y - dy * worldPerPx + (cy / (minDim * MAP_SCALE)) * invDelta),
        };
        panRef.current = nextPan;
        panTargetRef.current = nextPan;
        zoomRef.current = nextZoom;
        targetZoomRef.current = nextZoom;
        setZoom(+nextZoom.toFixed(2));
      }
      pinchRef.current = { dist: nextDist, midX, midY };
      movedRef.current = true;
      redrawRef.current();
      return;
    }

    if (dragRef.current) {
      const dx = event.clientX - dragRef.current.x;
      const dy = event.clientY - dragRef.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true;

      if (dragRef.current.mode === 'pan') {
        const rect = wrapperRef.current?.getBoundingClientRect();
        const minDim = Math.max(1, Math.min(rect?.width || 800, rect?.height || 600));
        const worldPerPx = 1 / (minDim * MAP_SCALE * zoomRef.current);
        const nextPan = {
          x: clampPan(panRef.current.x + dx * worldPerPx),
          y: clampPan(panRef.current.y - dy * worldPerPx),
        };
        panRef.current = nextPan;
        panTargetRef.current = nextPan;
      } else {
        rotationRef.current.y += dx * 0.008;
        rotationRef.current.x = Math.max(-1.2, Math.min(1.2, rotationRef.current.x + dy * 0.008));
      }
      dragRef.current = { ...dragRef.current, x: event.clientX, y: event.clientY };
      redrawRef.current();
    } else {
      findHovered(event);
    }
  };

  const handlePointerUp = event => {
    activePointersRef.current.delete(event.pointerId);
    if (activePointersRef.current.size < 2) pinchRef.current = null;
    dragRef.current = null;
    setIsPanDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const handleClick = event => {
    if (movedRef.current) return;
    const target = findHovered(event);
    if (!target) return;
    if (event.shiftKey) onAddToQueue?.(target);
    else onPlaySong?.(target);
  };

  const handleQueueTopFocus = () => {
    topGlowingSongs.forEach(song => onAddToQueue?.(song));
  };

  const hoveredCluster = hoveredSong && clusterById.get(hoveredSong.clusterId);
  const hoveredMetric = hoveredSong && tasteOverlay.metricsByKey.get(hoveredSong.songKey);
  const hoveredStatus = hoveredMetric ? STATUS_META[hoveredMetric.status] : null;
  const selectedCluster = selectedClusterId >= 0 ? clusterById.get(selectedClusterId) : null;

  const subtitle = galaxy.mode === 'audio'
    ? `Mapped by how ${galaxy.audio.count.toLocaleString()} songs sound (${galaxy.audio.model}).`
    : 'Mapped by title, artist and mood tags.';

  return (
    <div className="constellation-view">
      <div className="constellation-header constellation-header--studio">
        <div className="constellation-title-group">
          <Sparkles className="constellation-icon" size={18} />
          <div>
            <h2 className="constellation-title">
              MUSIC GALAXY{' '}
              <span className="constellation-title__count">
                · {points.length < songs.length
                  ? `${points.length.toLocaleString()} OF ${songs.length.toLocaleString()} TRACKS`
                  : `${songs.length.toLocaleString()} TRACKS`}
              </span>
            </h2>
            <p className="constellation-subtitle">{subtitle}</p>
          </div>
        </div>

        <div className="constellation-filters constellation-filters--center" role="group" aria-label="Highlight mode">
          <button type="button" className={`filter-chip ${highlightMode === 'focus' ? 'filter-chip--active' : ''}`} aria-pressed={highlightMode === 'focus'} onClick={() => setHighlightMode('focus')}>Focus</button>
          <button type="button" className={`filter-chip ${highlightMode === 'shift' ? 'filter-chip--active' : ''}`} aria-pressed={highlightMode === 'shift'} onClick={() => setHighlightMode('shift')}>
            <Flame size={12} style={{ marginRight: 4, verticalAlign: -1 }} />Shifts
          </button>
          <button type="button" className={`filter-chip ${highlightMode === 'all' ? 'filter-chip--active' : ''}`} aria-pressed={highlightMode === 'all'} onClick={() => setHighlightMode('all')}>All</button>
        </div>

        <div className="constellation-controls constellation-controls--compact">
          <button
            type="button"
            className={`filter-chip ${povMode ? 'filter-chip--active' : ''}`}
            aria-pressed={povMode}
            onClick={() => setPovMode(value => !value)}
            title={povMode ? 'Switch to zoomed-out galaxy overview' : 'Switch to first-person view inside the galaxy'}
          >
            <Navigation size={12} style={{ marginRight: 5 }} />{povMode ? 'First-person' : 'Overview'}
          </button>
          <details
            ref={popoverRef}
            className="constellation-popover"
            open={effectivePopoverOpen}
            onToggle={event => setPopoverOpen(event.currentTarget.open)}
          >
            <summary className="filter-chip" title="Filter map source, space, and FPS preset">
              <SlidersHorizontal size={12} style={{ marginRight: 5 }} />Filter &amp; GPU
            </summary>
            <div className="constellation-popover__panel" onClick={e => e.stopPropagation()}>
              <div className="constellation-popover__section">
                <span>Performance ({PERF_PRESETS[perfMode]?.label})</span>
                <div className="constellation-filters" role="group" aria-label="Rendering performance">
                  <Gauge size={12} className="constellation-perf-icon" aria-hidden="true" />
                  {Object.entries(PERF_PRESETS).map(([key, cfg]) => (
                    <button
                      key={key}
                      type="button"
                      className={`filter-chip ${perfMode === key ? 'filter-chip--active' : ''}`}
                      aria-pressed={perfMode === key}
                      onClick={() => setPerfMode(key)}
                    >
                      {key === 'eco' ? 'Eco' : cfg.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="constellation-popover__section">
                <span>Library filter</span>
                <div className="constellation-filters" role="group" aria-label="Songs on the map">
                  <button type="button" className={`filter-chip ${filterMode === 'all' ? 'filter-chip--active' : ''}`} aria-pressed={filterMode === 'all'} onClick={() => setFilterMode('all')}>All ({songs.length})</button>
                  <button type="button" className={`filter-chip ${filterMode === 'ready' ? 'filter-chip--active' : ''}`} aria-pressed={filterMode === 'ready'} onClick={() => setFilterMode('ready')}>Ready ({readyCount})</button>
                </div>
              </div>
              <button
                type="button"
                className={`filter-chip constellation-action-chip ${followPlaying ? 'filter-chip--active' : ''}`}
                aria-pressed={followPlaying}
                onClick={() => setFollowPlaying(value => !value)}
              >
                <Navigation size={12} />Auto-follow playing song
              </button>
            </div>
          </details>

          {onAddToQueue && readyCount > 0 && (
            <button type="button" className="filter-chip constellation-cta-cyan" onClick={handleQueueTopFocus} title="Queue top 5 glowing songs matching the current view">
              <ListPlus size={13} />Queue glowing (5)
            </button>
          )}
        </div>
      </div>
      <div
        className={`constellation-canvas-wrapper ${isPanDragging ? 'is-pan-dragging' : (dragMode === 'pan' || spacePanActive ? 'is-pan-cursor' : '')}`}
        ref={wrapperRef}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={event => {
          activePointersRef.current.delete(event.pointerId);
          if (activePointersRef.current.size < 2) pinchRef.current = null;
          dragRef.current = null;
          setIsPanDragging(false);
          movedRef.current = true;
        }}
        onLostPointerCapture={() => { dragRef.current = null; setIsPanDragging(false); }}
        onPointerLeave={() => { dragRef.current = null; setIsPanDragging(false); setHoveredSong(null); }}
        onContextMenu={event => event.preventDefault()}
        onClick={handleClick}
      >
        <canvas ref={canvasRef} className="constellation-canvas" aria-label="3D music galaxy map" />
        <div
          className="constellation-canvas-top"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          {categories.length > 0 && (
            <div className="constellation-cluster-legend" role="group" aria-label="Genre and tag categories">
              {categories.map(({ label, songs: catSongs }) => {
                const isSelected = selectedCategory === label;
                const isDimmed = Boolean(selectedCategory) && !isSelected;
                return (
                  <button
                    type="button"
                    key={label}
                    className={`constellation-cluster-chip ${isSelected ? 'constellation-cluster-chip--selected' : ''} ${isDimmed ? 'constellation-cluster-chip--dim' : ''}`}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedCategory(cur => (cur === label ? '' : label))}
                    onDoubleClick={() => onPlayCluster?.(catSongs)}
                    title={`Click to ${isSelected ? 'show all categories' : `highlight ${label} in 128D space`}${onPlayCluster ? ' · Double-click to play mix' : ''}`}
                  >
                    {label} · {catSongs.length}
                  </button>
                );
              })}
            </div>
          )}
          <div className="constellation-cluster-legend" role="group" aria-label="Clusters">
            {clusters.map(({ clusterId, songs: clusterSongs, label }) => {
              const stats = tasteOverlay.clusterSummary?.get(clusterId);
              const avgFocusPct = stats?.count ? Math.round((stats.sumFocus / stats.count) * 100) : null;
              const isSelected = selectedClusterId === clusterId;
              const isDimmed = selectedClusterId >= 0 && !isSelected;
              return (
                <button
                  type="button"
                  key={clusterId}
                  className={`constellation-cluster-chip ${isSelected ? 'constellation-cluster-chip--selected' : ''} ${isDimmed ? 'constellation-cluster-chip--dim' : ''}`}
                  aria-pressed={isSelected}
                  onClick={() => setSelectedClusterId(cur => (cur === clusterId ? -1 : clusterId))}
                  onDoubleClick={() => onPlayCluster?.(clusterSongs)}
                  onMouseEnter={() => setHoveredClusterId(clusterId)}
                  onMouseLeave={() => setHoveredClusterId(-1)}
                  onFocus={() => setHoveredClusterId(clusterId)}
                  onBlur={() => setHoveredClusterId(-1)}
                  title={`Click to ${isSelected ? 'show all clusters' : `fly to ${label}`}${onPlayCluster ? ' · Double-click to play mix' : ''}`}
                >
                  <i style={{ background: clusterColor(clusterId) }} />{label} · {clusterSongs.length}
                  {tasteOverlay.hasSignal && avgFocusPct !== null && <span className="constellation-chip-pct">{avgFocusPct}%</span>}
                </button>
              );
            })}
            {filteredSongs.length < songs.length && <small>Showing {filteredSongs.length.toLocaleString()} songs.</small>}
            {galaxy.excluded > 0 && <small>{galaxy.excluded.toLocaleString()} unanalysed songs — switch to Tags to view all.</small>}
          </div>
          {(currentPoint || selectedCluster) && (
            <div className="constellation-status-row">
              {currentPoint && <div className="constellation-now-playing"><Rotate3d size={15} /><span>Now playing: <strong>{currentPoint.track}</strong> · {currentCluster?.label || 'Cluster'}</span></div>}
              {selectedCluster && (
                <div className="constellation-cluster-focus-bar">
                  <span>Focused: <strong>{selectedCluster.label}</strong> ({selectedCluster.songs.length})</span>
                  {onPlayCluster && (
                    <button type="button" className="filter-chip filter-chip--active" onClick={() => onPlayCluster(selectedCluster.songs)}>
                      <Play size={12} style={{ marginRight: 4 }} />Play cluster
                    </button>
                  )}
                  <button type="button" className="filter-chip" onClick={() => setSelectedClusterId(-1)}>Reset</button>
                </div>
              )}
            </div>
          )}
        </div>
        {!webglReady && <div className="constellation-fallback">3D rendering is unavailable in this browser. Your library is still available in Ready and Search.</div>}
        <div
          className="constellation-zoom-controls constellation-zoom-overlay"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          title="Scroll to zoom · Drag to orbit · Right-drag, Shift-drag, or Pan tool to pan"
        >
          <button
            type="button"
            className={`constellation-mode-btn ${dragMode === 'orbit' && !spacePanActive ? 'is-active' : ''}`}
            onClick={() => setDragMode('orbit')}
            aria-pressed={dragMode === 'orbit'}
            aria-label="Orbit 3D rotation mode"
            title="Orbit rotation mode (Drag to rotate)"
          >
            <Rotate3d size={13} />
          </button>
          <button
            type="button"
            className={`constellation-mode-btn ${dragMode === 'pan' || spacePanActive ? 'is-active' : ''}`}
            onClick={() => setDragMode('pan')}
            aria-pressed={dragMode === 'pan'}
            aria-label="Pan camera mode"
            title="Pan mode (Drag, or hold Space / Shift / Right-click anytime)"
          >
            <Hand size={13} />
          </button>
          <span className="constellation-zoom-sep" aria-hidden="true" />
          <button type="button" onClick={() => stepZoom(0.8)} aria-label="Zoom out" title="Zoom out">−</button>
          <button
            type="button"
            className="constellation-zoom-value"
            onClick={resetView}
            title="Reset zoom & pan to 100%"
            aria-label={`Reset zoom (${Math.round(zoom * 100)}%)`}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" onClick={() => stepZoom(1.25)} aria-label="Zoom in" title="Zoom in">+</button>
          <button
            type="button"
            onClick={resetView}
            aria-label="Center & reset view"
            title="Center & reset view"
          >
            <LocateFixed size={13} />
          </button>
        </div>
        {currentPoint && trackProfile && (
          <aside className="constellation-track-hud" aria-label="Playing star traits and path" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
            <div className="constellation-hud-top">
              <span className="constellation-hud-kicker">
                <i className="constellation-tooltip__dot" style={{ background: clusterColor(currentPoint.clusterId) }} />
                {trackProfile.clusterLabel} ({trackProfile.clusterSize})
              </span>
              {trackProfile.bpm && <span className="constellation-hud-mono">{trackProfile.bpm} BPM</span>}
            </div>
            <div className="constellation-hud-title">{currentPoint.track}</div>
            <div className="constellation-hud-meta">
              <span>Genre: <strong>{trackProfile.genre}</strong></span>
              <span>Feel: <strong>{trackProfile.feel}</strong></span>
              {trackProfile.musicalKey && <span>Key: <strong>{trackProfile.musicalKey}</strong></span>}
              {trackProfile.energyPct !== null && <span>Energy: <strong>{trackProfile.energyPct}%</strong></span>}
            </div>
            {trackProfile.transition && (
              <div className="constellation-hud-path">
                <span className="constellation-hud-path-label">
                  Path from <strong>{trackProfile.transition.fromTrack}</strong>
                </span>
                <div className="constellation-hud-path-chips">
                  <span>{trackProfile.transition.sameCluster ? 'Same cluster' : 'Cluster bridge'}</span>
                  {trackProfile.transition.soundMatchPct !== null && <span>Sound {trackProfile.transition.soundMatchPct}%</span>}
                  {trackProfile.transition.seamMatchPct !== null && <span>Seam {trackProfile.transition.seamMatchPct}%</span>}
                  {trackProfile.transition.bpmDelta !== null && (
                    <span>{trackProfile.transition.bpmDelta >= 0 ? `+${trackProfile.transition.bpmDelta}` : trackProfile.transition.bpmDelta} BPM</span>
                  )}
                </div>
              </div>
            )}
          </aside>
        )}
        {topGlowingSongs.length > 0 && (
          <aside className="constellation-next-path" aria-label="Next constellation path" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
            <div className="constellation-next-path__head">
              <span>NEXT CONSTELLATION PATH</span>
              <span>{highlightMode === 'shift' ? 'SHIFT' : 'MATCH'}</span>
            </div>
            <div className="constellation-next-path__list">
              {topGlowingSongs.slice(0, 4).map((song, idx) => {
                const metric = tasteOverlay.metricsByKey.get(song.songKey);
                const pct = metric?.matchPct ?? Math.round((metric?.focus ?? 0.72) * 100);
                return (
                  <button
                    key={song.songKey}
                    type="button"
                    className="constellation-next-path__row"
                    onClick={() => onPlaySong?.(song)}
                  >
                    <span className="constellation-next-path__idx">{idx + 1}.</span>
                    <span className="constellation-next-path__dot" style={{ background: clusterColor(song.clusterId) }} />
                    <span className="constellation-next-path__track">{song.track}</span>
                    <span className="constellation-next-path__pct">{pct}%</span>
                  </button>
                );
              })}
            </div>
          </aside>
        )}
        {hoveredSong && (
          <div className="constellation-tooltip" style={{ left: `${tooltipPos.x + 14}px`, top: `${tooltipPos.y + 14}px` }}>
            <div className="tooltip-title">{hoveredSong.track || 'Unknown Track'}</div>
            <div className="tooltip-artist">{hoveredSong.artist || 'Unknown Artist'}</div>
            {hoveredCluster && (
              <div className="tooltip-artist">
                <i className="constellation-tooltip__dot" style={{ background: clusterColor(hoveredCluster.clusterId) }} />
                {hoveredCluster.label}
              </div>
            )}
            {hoveredStatus && (
              <div className={`constellation-tooltip__badge constellation-tooltip__badge--${hoveredStatus.tone}`}>
                {hoveredStatus.label}{tasteOverlay.hasSignal ? ` · ${hoveredMetric.matchPct}% match` : ''}
                {hoveredMetric.plays > 0 ? ` · ${hoveredMetric.plays}x played` : ''}
              </div>
            )}
            <div className="tooltip-action-hint"><Play size={12} style={{ marginRight: 4 }} />{onAddToQueue ? 'Click to play · Shift-click to queue' : 'Click to play'}</div>
          </div>
        )}
      </div>
    </div>
  );
}
