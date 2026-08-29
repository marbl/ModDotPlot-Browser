import type { MatrixTilePayload } from "./protocol";
import { initialViewport, panBy, zoomAt, type ViewportState } from "./viewport";
import { selectTileEvictionCandidate } from "./cache";

const MISSING_IDENTITY = 65_535;
const MAX_TILE_CACHE_BYTES = 192 * 1024 * 1024;

export interface PlotMetadata {
  resolution: number;
  domainLength: number;
  xLength: number;
  yLength: number;
}

export interface HoverDatum {
  matrixX: number;
  matrixY: number;
  genomicXStart: number;
  genomicXEnd: number;
  genomicYStart: number;
  genomicYEnd: number;
  identity: number | null;
  direction: number | null;
  directionSupport: number;
  quality: "preview" | "refined" | "exact";
}

export interface ViewChange {
  view: ViewportState;
  pixelWidth: number;
  pixelHeight: number;
}

interface GpuTile extends MatrixTilePayload {
  identityTexture: WebGLTexture;
  directionTexture: WebGLTexture;
  supportTexture: WebGLTexture;
  baseTexture: WebGLTexture | null;
  storageBytes: number;
  lastUsed: number;
}

interface Uniforms {
  tile: WebGLUniformLocation;
  view: WebGLUniformLocation;
  identity: WebGLUniformLocation;
  direction: WebGLUniformLocation;
  support: WebGLUniformLocation;
  bases: WebGLUniformLocation;
  mode: WebGLUniformLocation;
  heatmapMin: WebGLUniformLocation;
  heatmapMid: WebGLUniformLocation;
  heatmapMax: WebGLUniformLocation;
  exact: WebGLUniformLocation;
}

export class DotplotRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  #program: WebGLProgram;
  #uniforms: Uniforms;
  readonly #tiles = new Map<string, GpuTile>();
  #fallbackBaseTexture: WebGLTexture;
  readonly #resizeObserver: ResizeObserver;
  #metadata: PlotMetadata = { resolution: 1, domainLength: 1, xLength: 1, yLength: 1 };
  #view: ViewportState = initialViewport(1);
  #mode: "similarity" | "direction" = "similarity";
  #heatmap = { min: 0.80, midpoint: 0.90, max: 1.00 };
  #activeResolution = 1;
  #cachedTileBytes = 0;
  #useCounter = 0;
  #frameRequested = false;
  #frameResolvers: Array<() => void> = [];
  #pointerId: number | null = null;
  #lastPointer = { x: 0, y: 0 };
  #lastHoverEvent: PointerEvent | null = null;
  #hoverListener: ((datum: HoverDatum | null, event: PointerEvent) => void) | null = null;
  #viewListener: ((change: ViewChange) => void) | null = null;
  #evictionListener: ((tile: { resolution: number; x: number; y: number }) => void) | null = null;
  #contextLost = false;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 is required by moddotplot-rs");
    this.#gl = gl;
    this.#program = null as unknown as WebGLProgram;
    this.#uniforms = null as unknown as Uniforms;
    this.#fallbackBaseTexture = null as unknown as WebGLTexture;
    this.#initializeWebGL();
    this.#bindInteractions();
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas);
    this.#resize();
  }

  setComparison(metadata: PlotMetadata): void {
    this.clearTiles();
    this.#metadata = metadata;
    this.#activeResolution = metadata.resolution;
    const oneBase = Math.min(metadata.resolution, metadata.resolution / metadata.domainLength);
    this.#view = initialViewport(metadata.resolution, oneBase);
    this.#requestRender();
    this.#notifyViewChange();
  }

  addTile(payload: MatrixTilePayload): void {
    const key = tileKey(payload.resolution, payload.x, payload.y, payload.configDigest);
    const prior = this.#tiles.get(key);
    if (prior && qualityRank(prior.quality) > qualityRank(payload.quality)) return;
    if (prior) {
      this.#deleteTextures(prior);
      this.#cachedTileBytes -= prior.storageBytes;
    }

    const gl = this.#gl;
    const tile: GpuTile = {
      ...payload,
      identityTexture: createIntegerTexture(
        gl,
        payload.width,
        payload.height,
        gl.R16UI,
        gl.UNSIGNED_SHORT,
        payload.identity,
      ),
      directionTexture: createIntegerTexture(
        gl,
        payload.width,
        payload.height,
        gl.R16I,
        gl.SHORT,
        payload.direction,
      ),
      supportTexture: createIntegerTexture(
        gl,
        payload.width,
        payload.height,
        gl.R16UI,
        gl.UNSIGNED_SHORT,
        payload.directionSupport,
      ),
      baseTexture: payload.bases
        ? createIntegerTexture(
            gl,
            payload.width,
            1,
            gl.R8UI,
            gl.UNSIGNED_BYTE,
            payload.bases,
          )
        : null,
      storageBytes: tileStorageBytes(payload),
      lastUsed: ++this.#useCounter,
    };
    this.#tiles.set(key, tile);
    this.#cachedTileBytes += tile.storageBytes;
    this.#pruneTiles();
    this.#requestRender();
    if (this.#lastHoverEvent) {
      this.#hoverListener?.(this.#hoverAt(this.#lastHoverEvent), this.#lastHoverEvent);
    }
  }

  clearTiles(): void {
    for (const tile of this.#tiles.values()) this.#deleteTextures(tile);
    this.#tiles.clear();
    this.#cachedTileBytes = 0;
    this.#requestRender();
  }

  setColorMode(mode: "similarity" | "direction"): void {
    this.#mode = mode;
    this.#requestRender();
  }

  setHeatmapRange(minimum: number, midpoint: number, maximum: number): void {
    const min = Math.max(0, Math.min(1, minimum / 100));
    const max = Math.max(min + 0.0001, Math.min(1, maximum / 100));
    this.#heatmap = {
      min,
      midpoint: Math.max(min, Math.min(max, midpoint / 100)),
      max,
    };
    this.#requestRender();
  }

  setActiveResolution(resolution: number): void {
    this.#activeResolution = Math.max(this.#metadata.resolution, resolution);
    this.#pruneTiles();
    this.#requestRender();
    if (this.#lastHoverEvent) {
      this.#hoverListener?.(this.#hoverAt(this.#lastHoverEvent), this.#lastHoverEvent);
    }
  }

  estimatedBytes(): number {
    return this.#cachedTileBytes;
  }

  resetView(): void {
    this.#activeResolution = this.#metadata.resolution;
    this.#view = initialViewport(this.#metadata.resolution, this.#view.minSize);
    this.#requestRender();
    this.#notifyViewChange();
  }

  onHover(listener: (datum: HoverDatum | null, event: PointerEvent) => void): void {
    this.#hoverListener = listener;
  }

  onViewChange(listener: (change: ViewChange) => void): void {
    this.#viewListener = listener;
  }

  onTileEvict(listener: (tile: { resolution: number; x: number; y: number }) => void): void {
    this.#evictionListener = listener;
  }

  present(): Promise<void> {
    return new Promise((resolve) => {
      this.#frameResolvers.push(resolve);
      this.#requestRender();
    });
  }

  destroy(): void {
    this.clearTiles();
    this.#resizeObserver.disconnect();
    this.#gl.deleteTexture(this.#fallbackBaseTexture);
    this.#gl.deleteProgram(this.#program);
  }

  #initializeGeometry(): void {
    const gl = this.#gl;
    gl.useProgram(this.#program);
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("Unable to allocate WebGL vertex buffer");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(this.#program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(this.#uniforms.identity, 0);
    gl.uniform1i(this.#uniforms.direction, 1);
    gl.uniform1i(this.#uniforms.support, 2);
    gl.uniform1i(this.#uniforms.bases, 3);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  #initializeWebGL(): void {
    const gl = this.#gl;
    this.#program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.#uniforms = {
      tile: requiredUniform(gl, this.#program, "u_tile"),
      view: requiredUniform(gl, this.#program, "u_view"),
      identity: requiredUniform(gl, this.#program, "u_identity"),
      direction: requiredUniform(gl, this.#program, "u_direction"),
      support: requiredUniform(gl, this.#program, "u_support"),
      bases: requiredUniform(gl, this.#program, "u_bases"),
      mode: requiredUniform(gl, this.#program, "u_mode"),
      heatmapMin: requiredUniform(gl, this.#program, "u_heatmap_min"),
      heatmapMid: requiredUniform(gl, this.#program, "u_heatmap_mid"),
      heatmapMax: requiredUniform(gl, this.#program, "u_heatmap_max"),
      exact: requiredUniform(gl, this.#program, "u_exact"),
    };
    this.#fallbackBaseTexture = createIntegerTexture(
      gl,
      1,
      1,
      gl.R8UI,
      gl.UNSIGNED_BYTE,
      new Uint8Array([4]),
    );
    this.#initializeGeometry();
  }

  #bindInteractions(): void {
    this.#canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.#contextLost = true;
    });
    this.#canvas.addEventListener("webglcontextrestored", () => {
      this.#contextLost = false;
      this.#initializeWebGL();
      for (const tile of this.#tiles.values()) this.#restoreTextures(tile);
      this.#requestRender();
    });
    this.#canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = this.#canvas.getBoundingClientRect();
      const unitX = (event.clientX - rect.left) / rect.width;
      const unitY = 1 - (event.clientY - rect.top) / rect.height;
      this.#view = zoomAt(this.#view, Math.exp(event.deltaY * 0.0015), unitX, unitY);
      this.#requestRender();
      this.#notifyViewChange();
    });
    this.#canvas.addEventListener("pointerdown", (event) => {
      this.#pointerId = event.pointerId;
      this.#lastPointer = { x: event.clientX, y: event.clientY };
      this.#canvas.setPointerCapture(event.pointerId);
      this.#canvas.classList.add("is-panning");
    });
    this.#canvas.addEventListener("pointermove", (event) => {
      if (this.#pointerId === event.pointerId) {
        const rect = this.#canvas.getBoundingClientRect();
        const deltaX = event.clientX - this.#lastPointer.x;
        const deltaY = event.clientY - this.#lastPointer.y;
        this.#lastPointer = { x: event.clientX, y: event.clientY };
        this.#view = panBy(
          this.#view,
          (-deltaX / rect.width) * this.#view.width,
          (deltaY / rect.height) * this.#view.height,
        );
        this.#requestRender();
        this.#notifyViewChange();
      } else {
        this.#lastHoverEvent = event;
        this.#hoverListener?.(this.#hoverAt(event), event);
      }
    });
    const release = (event: PointerEvent): void => {
      if (this.#pointerId !== event.pointerId) return;
      this.#pointerId = null;
      this.#canvas.classList.remove("is-panning");
      this.#lastHoverEvent = event;
      this.#hoverListener?.(this.#hoverAt(event), event);
    };
    this.#canvas.addEventListener("pointerup", release);
    this.#canvas.addEventListener("pointercancel", release);
    this.#canvas.addEventListener("pointerleave", (event) => {
      if (this.#pointerId === null) {
        this.#lastHoverEvent = null;
        this.#hoverListener?.(null, event);
      }
    });
    this.#canvas.addEventListener("dblclick", () => this.resetView());
    this.#canvas.addEventListener("keydown", (event) => {
      const panFraction = 0.1;
      if (event.key === "ArrowLeft") {
        this.#view = panBy(this.#view, -this.#view.width * panFraction, 0);
      } else if (event.key === "ArrowRight") {
        this.#view = panBy(this.#view, this.#view.width * panFraction, 0);
      } else if (event.key === "ArrowUp") {
        this.#view = panBy(this.#view, 0, this.#view.height * panFraction);
      } else if (event.key === "ArrowDown") {
        this.#view = panBy(this.#view, 0, -this.#view.height * panFraction);
      } else if (event.key === "+" || event.key === "=") {
        this.#view = zoomAt(this.#view, 0.8, 0.5, 0.5);
      } else if (event.key === "-" || event.key === "_") {
        this.#view = zoomAt(this.#view, 1.25, 0.5, 0.5);
      } else if (event.key === "Home") {
        this.resetView();
        event.preventDefault();
        return;
      } else {
        return;
      }
      event.preventDefault();
      this.#requestRender();
      this.#notifyViewChange();
    });
  }

  #hoverAt(event: PointerEvent): HoverDatum | null {
    const rect = this.#canvas.getBoundingClientRect();
    const unitX = (event.clientX - rect.left) / rect.width;
    const unitY = 1 - (event.clientY - rect.top) / rect.height;
    const matrixX = this.#view.x + unitX * this.#view.width;
    const matrixY = this.#view.y + unitY * this.#view.height;
    if (
      matrixX < 0 ||
      matrixY < 0 ||
      matrixX >= this.#metadata.resolution ||
      matrixY >= this.#metadata.resolution
    ) {
      return null;
    }
    let tile: GpuTile | undefined;
    let xIndex = 0;
    let yIndex = 0;
    for (const candidate of this.#tiles.values()) {
      if (!this.#isRenderableResolution(candidate.resolution)) continue;
      const scale = candidate.resolution / this.#metadata.resolution;
      const candidateX = Math.floor(matrixX * scale);
      const candidateY = Math.floor(matrixY * scale);
      if (
        candidateX >= candidate.x &&
        candidateX < candidate.x + candidate.width &&
        candidateY >= candidate.y &&
        candidateY < candidate.y + candidate.height &&
        (
          !tile
          || candidate.resolution > tile.resolution
          || (
            candidate.resolution === tile.resolution
            && qualityRank(candidate.quality) > qualityRank(tile.quality)
          )
        )
      ) {
        tile = candidate;
        xIndex = candidateX;
        yIndex = candidateY;
      }
    }
    if (!tile) return null;
    const offset = (yIndex - tile.y) * tile.width + (xIndex - tile.x);
    const encodedIdentity = tile.identity[offset];
    const encodedDirection = tile.direction[offset];
    const directionSupport = tile.directionSupport[offset] ?? 0;
    if (encodedIdentity === undefined || encodedDirection === undefined) return null;
    return {
      matrixX,
      matrixY,
      genomicXStart: (xIndex / tile.resolution) * this.#metadata.domainLength,
      genomicXEnd: ((xIndex + 1) / tile.resolution) * this.#metadata.domainLength,
      genomicYStart: (yIndex / tile.resolution) * this.#metadata.domainLength,
      genomicYEnd: ((yIndex + 1) / tile.resolution) * this.#metadata.domainLength,
      identity: encodedIdentity === MISSING_IDENTITY ? null : encodedIdentity / 100,
      direction: directionSupport === 0 ? null : encodedDirection / 32_767,
      directionSupport,
      quality: tile.quality,
    };
  }

  #resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.max(1, Math.round(this.#canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.#canvas.clientHeight * dpr));
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
      this.#gl.viewport(0, 0, width, height);
    }
    this.#requestRender();
    this.#notifyViewChange();
  }

  #requestRender(): void {
    if (this.#frameRequested) return;
    this.#frameRequested = true;
    requestAnimationFrame(() => {
      this.#frameRequested = false;
      this.#render();
      const resolvers = this.#frameResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    });
  }

  #render(): void {
    if (this.#contextLost) return;
    const gl = this.#gl;
    gl.clearColor(0.975, 0.973, 0.965, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.#program);
    gl.uniform4f(this.#uniforms.view, this.#view.x, this.#view.y, this.#view.width, this.#view.height);
    gl.uniform1i(this.#uniforms.mode, this.#mode === "similarity" ? 0 : 1);
    gl.uniform1f(this.#uniforms.heatmapMin, this.#heatmap.min);
    gl.uniform1f(this.#uniforms.heatmapMid, this.#heatmap.midpoint);
    gl.uniform1f(this.#uniforms.heatmapMax, this.#heatmap.max);

    const tiles = [...this.#tiles.values()].sort((left, right) =>
      left.resolution - right.resolution || qualityRank(left.quality) - qualityRank(right.quality)
    );
    for (const tile of tiles) {
      if (!this.#isRenderableResolution(tile.resolution)) continue;
      const bounds = tileBounds(tile, this.#metadata.resolution);
      if (!intersectsView(bounds, this.#view)) continue;
      tile.lastUsed = ++this.#useCounter;
      gl.uniform4f(this.#uniforms.tile, bounds.x, bounds.y, bounds.endX, bounds.endY);
      gl.uniform1i(this.#uniforms.exact, tile.quality === "exact" ? 1 : 0);
      bindTexture(gl, tile.identityTexture, gl.TEXTURE0);
      bindTexture(gl, tile.directionTexture, gl.TEXTURE1);
      bindTexture(gl, tile.supportTexture, gl.TEXTURE2);
      bindTexture(gl, tile.baseTexture ?? this.#fallbackBaseTexture, gl.TEXTURE3);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  #deleteTextures(tile: GpuTile): void {
    this.#gl.deleteTexture(tile.identityTexture);
    this.#gl.deleteTexture(tile.directionTexture);
    this.#gl.deleteTexture(tile.supportTexture);
    if (tile.baseTexture) this.#gl.deleteTexture(tile.baseTexture);
  }

  #restoreTextures(tile: GpuTile): void {
    const gl = this.#gl;
    tile.identityTexture = createIntegerTexture(
      gl, tile.width, tile.height, gl.R16UI, gl.UNSIGNED_SHORT, tile.identity,
    );
    tile.directionTexture = createIntegerTexture(
      gl, tile.width, tile.height, gl.R16I, gl.SHORT, tile.direction,
    );
    tile.supportTexture = createIntegerTexture(
      gl, tile.width, tile.height, gl.R16UI, gl.UNSIGNED_SHORT, tile.directionSupport,
    );
    tile.baseTexture = tile.bases
      ? createIntegerTexture(gl, tile.width, 1, gl.R8UI, gl.UNSIGNED_BYTE, tile.bases)
      : null;
  }

  #notifyViewChange(): void {
    this.#viewListener?.({
      view: { ...this.#view },
      pixelWidth: this.#canvas.clientWidth,
      pixelHeight: this.#canvas.clientHeight,
    });
  }

  #pruneTiles(): void {
    while (this.#cachedTileBytes > MAX_TILE_CACHE_BYTES) {
      const expired = selectTileEvictionCandidate(
        [...this.#tiles.entries()].map(([key, tile]) => ({
          key,
          resolution: tile.resolution,
          lastUsed: tile.lastUsed,
          visible: intersectsView(tileBounds(tile, this.#metadata.resolution), this.#view),
        })),
        this.#metadata.resolution,
        this.#activeResolution,
      );
      if (!expired) return;
      const key = expired.key;
      const tile = this.#tiles.get(key);
      if (!tile) continue;
      this.#deleteTextures(tile);
      this.#tiles.delete(key);
      this.#cachedTileBytes -= tile.storageBytes;
      this.#evictionListener?.({ resolution: tile.resolution, x: tile.x, y: tile.y });
    }
  }

  #isRenderableResolution(resolution: number): boolean {
    return resolution >= this.#metadata.resolution && resolution <= this.#activeResolution;
  }
}

interface TileBounds {
  x: number;
  y: number;
  endX: number;
  endY: number;
}

function tileBounds(tile: MatrixTilePayload, baseResolution: number): TileBounds {
  const scale = baseResolution / tile.resolution;
  return {
    x: tile.x * scale,
    y: tile.y * scale,
    endX: (tile.x + tile.width) * scale,
    endY: (tile.y + tile.height) * scale,
  };
}

function intersectsView(tile: TileBounds, view: ViewportState): boolean {
  return (
    tile.x < view.x + view.width &&
    tile.endX > view.x &&
    tile.y < view.y + view.height &&
    tile.endY > view.y
  );
}

function tileKey(resolution: number, x: number, y: number, configDigest: string): string {
  return `${resolution}:${x}:${y}:${configDigest}`;
}

function qualityRank(quality: MatrixTilePayload["quality"]): number {
  return quality === "preview" ? 0 : quality === "refined" ? 1 : 2;
}

function tileStorageBytes(tile: MatrixTilePayload): number {
  const channels = tile.identity.byteLength
    + tile.direction.byteLength
    + tile.directionSupport.byteLength
    + (tile.bases?.byteLength ?? 0);
  // Typed arrays remain available for hover inspection while WebGL retains a copy.
  return channels * 2;
}

function bindTexture(gl: WebGL2RenderingContext, texture: WebGLTexture, unit: number): void {
  gl.activeTexture(unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

function createIntegerTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  internalFormat: number,
  type: number,
  data: ArrayBufferView,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to allocate WebGL texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RED_INTEGER, type, data);
  return texture;
}

function requiredUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`Shader uniform ${name} is unavailable`);
  return location;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to allocate WebGL program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "Unable to link WebGL program");
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to allocate WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "Unable to compile WebGL shader");
  }
  return shader;
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
uniform vec4 u_tile;
uniform vec4 u_view;
out vec2 v_uv;

void main() {
  vec2 data_position = mix(u_tile.xy, u_tile.zw, a_position);
  vec2 unit_position = (data_position - u_view.xy) / u_view.zw;
  gl_Position = vec4(unit_position * 2.0 - 1.0, 0.0, 1.0);
  v_uv = a_position;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp isampler2D;

in vec2 v_uv;
uniform usampler2D u_identity;
uniform isampler2D u_direction;
uniform usampler2D u_support;
uniform usampler2D u_bases;
uniform int u_mode;
uniform int u_exact;
uniform float u_heatmap_min;
uniform float u_heatmap_mid;
uniform float u_heatmap_max;
out vec4 out_color;

vec3 similarity_palette(float value) {
  vec3 low = vec3(0.965, 0.925, 0.615);
  vec3 middle = vec3(0.909, 0.365, 0.224);
  vec3 high = vec3(0.190, 0.055, 0.263);
  float safe_mid = max(u_heatmap_mid, u_heatmap_min + 0.00001);
  float safe_max = max(u_heatmap_max, safe_mid + 0.00001);
  if (value < safe_mid) {
    return mix(low, middle, smoothstep(u_heatmap_min, safe_mid, value));
  }
  return mix(middle, high, smoothstep(safe_mid, safe_max, value));
}

vec3 base_palette(uint base) {
  if (base == 0u) return vec3(0.20, 0.68, 0.24); // A
  if (base == 1u) return vec3(0.12, 0.45, 0.88); // C
  if (base == 2u) return vec3(0.96, 0.64, 0.12); // G
  if (base == 3u) return vec3(0.88, 0.20, 0.19); // T
  return vec3(0.62, 0.60, 0.62);
}

void main() {
  uint encoded = texture(u_identity, v_uv).r;
  if (encoded == 65535u) {
    out_color = vec4(0.975, 0.973, 0.965, 1.0);
    return;
  }
  float identity = float(encoded) / 10000.0;
  if (u_mode == 0 && identity < u_heatmap_min) {
    out_color = vec4(0.975, 0.973, 0.965, 1.0);
    return;
  }
  if (u_mode == 0 && identity > u_heatmap_max) {
    out_color = vec4(0.02, 0.018, 0.022, 1.0);
    return;
  }

  vec3 color;
  if (u_mode == 0) {
    color = u_exact == 1
      ? base_palette(texture(u_bases, vec2(v_uv.x, 0.5)).r)
      : similarity_palette(identity);
  } else {
    uint support = texture(u_support, v_uv).r;
    float direction = float(texture(u_direction, v_uv).r) / 32767.0;
    vec3 forward_color = vec3(0.055, 0.455, 0.624);
    vec3 reverse_color = vec3(0.795, 0.225, 0.350);
    vec3 neutral_color = vec3(0.47, 0.45, 0.48);
    if (support == 0u) {
      color = neutral_color;
    } else {
      float support_confidence = 1.0 - exp(-float(support) / 8.0);
      color = mix(
        neutral_color,
        direction >= 0.0 ? forward_color : reverse_color,
        abs(direction) * support_confidence
      );
    }
    float safe_max = max(u_heatmap_max, u_heatmap_min + 0.00001);
    color = mix(vec3(0.975, 0.973, 0.965), color, smoothstep(u_heatmap_min, safe_max, identity));
  }
  out_color = vec4(color, 1.0);
}`;
