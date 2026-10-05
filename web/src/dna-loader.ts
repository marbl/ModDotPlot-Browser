export interface DnaLoaderOptions {
  size?: number;
  color?: string;
  speed?: number;
  basePairs?: number;
  basePairsPerTurn?: number;
  riseAngstroms?: number;
  diameterAngstroms?: number;
  minorGrooveAngleDegrees?: number;
  className?: string;
}

/** Canonical, sequence-averaged B-DNA dimensions in solution. */
export const B_DNA = Object.freeze({
  basePairsPerTurn: 10.5,
  twistDegreesPerBasePair: 360 / 10.5,
  riseAngstroms: 3.4,
  pitchAngstroms: 3.4 * 10.5,
  diameterAngstroms: 20,
  minorGrooveAngleDegrees: 120,
});

type Point = { x: number; y: number; depth: number };

export class DnaLoader {
  readonly canvas: HTMLCanvasElement;

  private readonly context: CanvasRenderingContext2D;
  private readonly options: Required<Omit<DnaLoaderOptions, "className">>;
  private frame = 0;
  private phase = 0;
  private previousTime = 0;
  private running = false;
  private reduceMotion = false;

  constructor(options: DnaLoaderOptions = {}) {
    this.options = {
      size: options.size ?? 112,
      color: options.color ?? "#747982",
      speed: options.speed ?? 0.72,
      basePairs: Math.max(2, Math.round(options.basePairs ?? 22)),
      basePairsPerTurn: options.basePairsPerTurn ?? B_DNA.basePairsPerTurn,
      riseAngstroms: options.riseAngstroms ?? B_DNA.riseAngstroms,
      diameterAngstroms: options.diameterAngstroms ?? B_DNA.diameterAngstroms,
      minorGrooveAngleDegrees:
        options.minorGrooveAngleDegrees ?? B_DNA.minorGrooveAngleDegrees,
    };

    this.canvas = document.createElement("canvas");
    this.canvas.className = options.className ?? "dna-loader";
    this.canvas.style.width = `${this.options.size}px`;
    this.canvas.style.height = `${this.options.size}px`;
    this.canvas.setAttribute("role", "progressbar");
    this.canvas.setAttribute("aria-label", "Loading");

    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is not supported in this browser.");
    this.context = context;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reduceMotion = motion.matches;
    motion.addEventListener?.("change", (event) => {
      this.reduceMotion = event.matches;
    });

    this.resize();
    window.addEventListener("resize", this.resize, { passive: true });
  }

  mount(target: Element): this {
    target.append(this.canvas);
    this.start();
    return this;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.previousTime = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  destroy(): void {
    this.stop();
    window.removeEventListener("resize", this.resize);
    this.canvas.remove();
  }

  private resize = (): void => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const size = this.options.size;
    this.canvas.width = Math.round(size * ratio);
    this.canvas.height = Math.round(size * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  };

  private tick = (time: number): void => {
    if (!this.running) return;
    const elapsed = Math.min((time - this.previousTime) / 1000, 0.05);
    this.previousTime = time;
    if (!this.reduceMotion) this.phase += elapsed * this.options.speed * Math.PI * 2;
    this.draw();
    this.frame = requestAnimationFrame(this.tick);
  };

  private draw(): void {
    const {
      size,
      color,
      basePairs,
      basePairsPerTurn,
      riseAngstroms,
      diameterAngstroms,
      minorGrooveAngleDegrees,
    } = this.options;
    const ctx = this.context;
    const tau = Math.PI * 2;
    const centerX = size / 2;

    // Preserve physical proportions by deriving pixels from Ångströms.
    const molecularHeight = (basePairs - 1) * riseAngstroms;
    const scale = Math.min(
      (size * 0.76) / molecularHeight,
      (size * 0.68) / diameterAngstroms,
    );
    const height = molecularHeight * scale;
    const radius = (diameterAngstroms / 2) * scale;
    const top = (size - height) / 2 - size * 0.025;
    const rise = riseAngstroms * scale;
    const twist = tau / basePairsPerTurn;
    const grooveOffset = minorGrooveAngleDegrees * Math.PI / 180;

    ctx.clearRect(0, 0, size, size);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.save();
    ctx.filter = `blur(${Math.max(1.5, size * 0.025)}px)`;
    ctx.fillStyle = "rgba(42, 46, 52, 0.17)";
    ctx.beginPath();
    ctx.ellipse(
      centerX,
      top + height + size * 0.065,
      radius * 0.9,
      size * 0.022,
      0,
      0,
      tau,
    );
    ctx.fill();
    ctx.restore();

    // Increasing z and angle together gives a right-handed helix.
    const point = (strand: 0 | 1, bpPosition: number): Point => {
      const angle = this.phase - bpPosition * twist +
        (strand === 0 ? 0 : grooveOffset);
      return {
        x: centerX + Math.sin(angle) * radius,
        y: top + bpPosition * rise,
        depth: Math.cos(angle),
      };
    };

    // One rung per base pair, separated by one 3.4 Å axial rise.
    const rungs = Array.from({ length: basePairs }, (_, bp) => {
      const a = point(0, bp);
      const b = point(1, bp);
      return { a, b, y: top + bp * rise, depth: (a.depth + b.depth) / 2 };
    }).sort((a, b) => a.depth - b.depth);

    for (const rung of rungs) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.28 + (rung.depth + 1) * 0.16;
      ctx.lineWidth = Math.max(1, size * 0.0095);
      ctx.beginPath();
      ctx.moveTo(rung.a.x, rung.a.y);
      ctx.lineTo(centerX, rung.y);
      ctx.lineTo(rung.b.x, rung.b.y);
      ctx.stroke();
    }

    // Depth-sort short backbone segments so crossings rotate correctly.
    const segments: Array<{ a: Point; b: Point; depth: number }> = [];
    const subdivisions = 8;
    for (const strand of [0, 1] as const) {
      for (let bp = 0; bp < basePairs - 1; bp += 1) {
        for (let sub = 0; sub < subdivisions; sub += 1) {
          const a = point(strand, bp + sub / subdivisions);
          const b = point(strand, bp + (sub + 1) / subdivisions);
          segments.push({ a, b, depth: (a.depth + b.depth) / 2 });
        }
      }
    }
    segments.sort((a, b) => a.depth - b.depth);

    for (const segment of segments) {
      const depth01 = (segment.depth + 1) / 2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.46 + depth01 * 0.46;
      ctx.lineWidth = Math.max(1.8, size * (0.017 + depth01 * 0.007));
      ctx.beginPath();
      ctx.moveTo(segment.a.x, segment.a.y);
      ctx.lineTo(segment.b.x, segment.b.y);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }
}
