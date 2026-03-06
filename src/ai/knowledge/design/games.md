# Games & Interactive

## When to Use This

Use these patterns when building browser-based games, interactive simulations, physics demos, or any canvas-based experience. These patterns cover the complete game development lifecycle from canvas setup through game loop, input, collision, particles, and state management.

## Quick Start

### Dependencies

```bash
# No mandatory dependencies — all patterns use native browser APIs
# Optional: math helpers
npm install gl-matrix   # Vector/matrix math for complex games
```

### Key Principles

- Always use `requestAnimationFrame` for the game loop — never `setInterval`
- Store game state in refs, not state — `useState` causes re-renders on every frame and breaks the loop
- Cancel animation frames on component unmount — memory leaks are common in game components
- Separate update logic from render logic — update first, then draw
- Use `delta time` for physics so the game runs at the same speed on all frame rates

## Patterns

### 1. Canvas Setup with React

```tsx
import { useRef, useEffect } from "react";

interface GameCanvasProps {
  width?: number;
  height?: number;
}

export function GameCanvas({ width = 800, height = 600 }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Handle high-DPI displays (retina)
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    let frameId: number;

    function gameLoop() {
      ctx!.clearRect(0, 0, width, height);

      // Draw background
      ctx!.fillStyle = "#1a1a2e";
      ctx!.fillRect(0, 0, width, height);

      // Your render code here

      frameId = requestAnimationFrame(gameLoop);
    }

    frameId = requestAnimationFrame(gameLoop);

    return () => cancelAnimationFrame(frameId);
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      className="block rounded-xl shadow-2xl"
      style={{ imageRendering: "pixelated" }}
    />
  );
}
```

### 2. Full Game Loop with Delta Time

```tsx
import { useRef, useEffect, useCallback } from "react";

type Vec2 = { x: number; y: number };

type Ball = {
  pos: Vec2;
  vel: Vec2;
  radius: number;
  color: string;
};

function createBall(): Ball {
  return {
    pos: { x: 400, y: 300 },
    vel: {
      x: (Math.random() - 0.5) * 300,
      y: (Math.random() - 0.5) * 300,
    },
    radius: 20,
    color: `hsl(${Math.random() * 360}, 70%, 60%)`,
  };
}

export function BouncingBalls() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ballsRef = useRef<Ball[]>(Array.from({ length: 5 }, createBall));
  const lastTimeRef = useRef<number>(0);
  const frameIdRef = useRef<number>(0);

  const W = 800;
  const H = 500;

  const update = useCallback((dt: number) => {
    const balls = ballsRef.current;
    for (const ball of balls) {
      // Move
      ball.pos.x += ball.vel.x * dt;
      ball.pos.y += ball.vel.y * dt;

      // Bounce off walls
      if (ball.pos.x - ball.radius < 0) {
        ball.pos.x = ball.radius;
        ball.vel.x = Math.abs(ball.vel.x);
      }
      if (ball.pos.x + ball.radius > W) {
        ball.pos.x = W - ball.radius;
        ball.vel.x = -Math.abs(ball.vel.x);
      }
      if (ball.pos.y - ball.radius < 0) {
        ball.pos.y = ball.radius;
        ball.vel.y = Math.abs(ball.vel.y);
      }
      if (ball.pos.y + ball.radius > H) {
        ball.pos.y = H - ball.radius;
        ball.vel.y = -Math.abs(ball.vel.y);
      }
    }
  }, []);

  const render = useCallback((ctx: CanvasRenderingContext2D) => {
    // Background
    ctx.fillStyle = "#0f0f23";
    ctx.fillRect(0, 0, W, H);

    // Balls
    for (const ball of ballsRef.current) {
      ctx.beginPath();
      ctx.arc(ball.pos.x, ball.pos.y, ball.radius, 0, Math.PI * 2);
      ctx.fillStyle = ball.color;
      ctx.fill();

      // Glow effect
      const grd = ctx.createRadialGradient(
        ball.pos.x - ball.radius * 0.3,
        ball.pos.y - ball.radius * 0.3,
        ball.radius * 0.1,
        ball.pos.x,
        ball.pos.y,
        ball.radius
      );
      grd.addColorStop(0, "rgba(255,255,255,0.4)");
      grd.addColorStop(1, "rgba(0,0,0,0)");
      ctx.beginPath();
      ctx.arc(ball.pos.x, ball.pos.y, ball.radius, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    function loop(timestamp: number) {
      const dt = Math.min((timestamp - lastTimeRef.current) / 1000, 0.05); // cap at 50ms
      lastTimeRef.current = timestamp;
      update(dt);
      render(ctx!);
      frameIdRef.current = requestAnimationFrame(loop);
    }

    frameIdRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameIdRef.current);
  }, [update, render]);

  return <canvas ref={canvasRef} className="block rounded-xl border border-gray-800" />;
}
```

### 3. Keyboard and Mouse Input Handling

```tsx
import { useRef, useEffect } from "react";

// Input manager — tracks current key state and mouse position
function createInputManager() {
  const keys = new Set<string>();
  let mouseX = 0;
  let mouseY = 0;
  let mouseDown = false;

  return {
    keys,
    get mouse() { return { x: mouseX, y: mouseY, down: mouseDown }; },
    isDown: (key: string) => keys.has(key),
    // Call these in useEffect
    onKeyDown: (e: KeyboardEvent) => { keys.add(e.code); e.preventDefault(); },
    onKeyUp: (e: KeyboardEvent) => { keys.delete(e.code); },
    onMouseMove: (e: MouseEvent, canvas: HTMLCanvasElement) => {
      const rect = canvas.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
    },
    onMouseDown: () => { mouseDown = true; },
    onMouseUp: () => { mouseDown = false; },
  };
}

export function PlayerGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef(createInputManager());
  const playerRef = useRef({ x: 200, y: 200, speed: 200 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const input = inputRef.current;
    const W = 600;
    const H = 400;

    // Setup canvas
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    canvas.tabIndex = 0; // needed to receive keyboard events

    // Bind input events
    const handleKeyDown = input.onKeyDown;
    const handleKeyUp = input.onKeyUp;
    const handleMouseMove = (e: MouseEvent) => input.onMouseMove(e, canvas);

    canvas.addEventListener("keydown", handleKeyDown);
    canvas.addEventListener("keyup", handleKeyUp);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mousedown", input.onMouseDown);
    canvas.addEventListener("mouseup", input.onMouseUp);

    let lastTime = 0;
    let frameId: number;

    function loop(ts: number) {
      const dt = Math.min((ts - lastTime) / 1000, 0.05);
      lastTime = ts;
      const player = playerRef.current;

      // WASD / Arrow movement
      if (input.isDown("ArrowLeft") || input.isDown("KeyA")) player.x -= player.speed * dt;
      if (input.isDown("ArrowRight") || input.isDown("KeyD")) player.x += player.speed * dt;
      if (input.isDown("ArrowUp") || input.isDown("KeyW")) player.y -= player.speed * dt;
      if (input.isDown("ArrowDown") || input.isDown("KeyS")) player.y += player.speed * dt;

      // Clamp to bounds
      player.x = Math.max(16, Math.min(W - 16, player.x));
      player.y = Math.max(16, Math.min(H - 16, player.y));

      // Render
      ctx!.fillStyle = "#1a1a2e";
      ctx!.fillRect(0, 0, W, H);

      // Draw player
      ctx!.beginPath();
      ctx!.arc(player.x, player.y, 16, 0, Math.PI * 2);
      ctx!.fillStyle = "#60a5fa";
      ctx!.fill();
      ctx!.strokeStyle = "#93c5fd";
      ctx!.lineWidth = 2;
      ctx!.stroke();

      // Draw mouse cursor indicator
      const mouse = input.mouse;
      ctx!.beginPath();
      ctx!.arc(mouse.x, mouse.y, 4, 0, Math.PI * 2);
      ctx!.fillStyle = mouse.down ? "#f87171" : "#fbbf24";
      ctx!.fill();

      // Instructions
      ctx!.fillStyle = "rgba(255,255,255,0.4)";
      ctx!.font = "12px monospace";
      ctx!.fillText("WASD / Arrow keys to move", 12, H - 12);

      frameId = requestAnimationFrame(loop);
    }

    canvas.focus();
    frameId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frameId);
      canvas.removeEventListener("keydown", handleKeyDown);
      canvas.removeEventListener("keyup", handleKeyUp);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mousedown", input.onMouseDown);
      canvas.removeEventListener("mouseup", input.onMouseUp);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="block rounded-xl border border-gray-700 outline-none focus:ring-2 focus:ring-blue-500"
    />
  );
}
```

### 4. Collision Detection (AABB and Circle)

```tsx
// Axis-Aligned Bounding Box collision
type AABB = { x: number; y: number; w: number; h: number };

function aabbCollides(a: AABB, b: AABB): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

// Circle-Circle collision
type Circle = { x: number; y: number; r: number };

function circleCollides(a: Circle, b: Circle): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const distSq = dx * dx + dy * dy;
  const minDist = a.r + b.r;
  return distSq < minDist * minDist; // avoid sqrt for performance
}

// Circle-AABB collision
function circleAABBCollides(circle: Circle, box: AABB): boolean {
  // Find closest point on the box to the circle center
  const closestX = Math.max(box.x, Math.min(circle.x, box.x + box.w));
  const closestY = Math.max(box.y, Math.min(circle.y, box.y + box.h));
  const dx = circle.x - closestX;
  const dy = circle.y - closestY;
  return dx * dx + dy * dy < circle.r * circle.r;
}

// Elastic collision response for two circles
function resolveCircleCollision(
  a: Circle & { vx: number; vy: number; mass: number },
  b: Circle & { vx: number; vy: number; mass: number }
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return;

  // Normal vector
  const nx = dx / dist;
  const ny = dy / dist;

  // Relative velocity along normal
  const dvx = a.vx - b.vx;
  const dvy = a.vy - b.vy;
  const dvDotN = dvx * nx + dvy * ny;

  if (dvDotN > 0) return; // already moving apart

  const impulse = (2 * dvDotN) / (a.mass + b.mass);
  a.vx -= impulse * b.mass * nx;
  a.vy -= impulse * b.mass * ny;
  b.vx += impulse * a.mass * nx;
  b.vy += impulse * a.mass * ny;

  // Positional correction to prevent overlap
  const overlap = a.r + b.r - dist;
  if (overlap > 0) {
    const correction = overlap / 2;
    a.x -= nx * correction;
    a.y -= ny * correction;
    b.x += nx * correction;
    b.y += ny * correction;
  }
}

// Broad phase: spatial grid for many objects
function createSpatialGrid(cellSize: number) {
  const cells = new Map<string, number[]>();

  function key(x: number, y: number) {
    return `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
  }

  return {
    clear: () => cells.clear(),
    insert: (id: number, x: number, y: number, r: number) => {
      const x0 = Math.floor((x - r) / cellSize);
      const x1 = Math.floor((x + r) / cellSize);
      const y0 = Math.floor((y - r) / cellSize);
      const y1 = Math.floor((y + r) / cellSize);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const k = `${cx},${cy}`;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k)!.push(id);
        }
      }
    },
    query: (x: number, y: number, r: number): number[] => {
      const result = new Set<number>();
      const x0 = Math.floor((x - r) / cellSize);
      const x1 = Math.floor((x + r) / cellSize);
      const y0 = Math.floor((y - r) / cellSize);
      const y1 = Math.floor((y + r) / cellSize);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const k = `${cx},${cy}`;
          cells.get(k)?.forEach((id) => result.add(id));
        }
      }
      return [...result];
    },
  };
}
```

### 5. Particle Effects

```tsx
type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;       // 0–1, starts at 1, dies at 0
  maxLife: number;
  size: number;
  color: string;
  alpha: number;
};

class ParticleSystem {
  particles: Particle[] = [];

  emit(x: number, y: number, count: number, options?: {
    speed?: number;
    color?: string;
    spread?: number;
    gravity?: number;
  }) {
    const { speed = 150, color = "#fbbf24", spread = Math.PI * 2 } = options ?? {};
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * spread;
      const s = speed * (0.5 + Math.random() * 0.5);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * s,
        vy: Math.sin(angle) * s,
        life: 1,
        maxLife: 0.5 + Math.random() * 0.5,
        size: 2 + Math.random() * 4,
        color,
        alpha: 1,
      });
    }
  }

  update(dt: number, gravity = 400) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.vy += gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt / p.maxLife;
      p.alpha = Math.max(0, p.life);
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    for (const p of this.particles) {
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.restore();
    }
  }
}

// Explosion burst: different colors per stage
function emitExplosion(system: ParticleSystem, x: number, y: number) {
  // Sparks
  system.emit(x, y, 20, { speed: 250, color: "#fbbf24", spread: Math.PI * 2 });
  // Inner burst
  system.emit(x, y, 10, { speed: 80, color: "#f97316", spread: Math.PI * 2 });
  // Smoke (slow rising)
  system.emit(x, y, 8, { speed: 30, color: "#9ca3af", spread: 0.8, gravity: -50 });
}

export function ParticleDemo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const systemRef = useRef(new ParticleSystem());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = 600;
    const H = 400;
    canvas.width = W;
    canvas.height = H;

    let lastTime = 0;
    let frameId: number;

    const handleClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      emitExplosion(systemRef.current, e.clientX - rect.left, e.clientY - rect.top);
    };
    canvas.addEventListener("click", handleClick);

    function loop(ts: number) {
      const dt = Math.min((ts - lastTime) / 1000, 0.05);
      lastTime = ts;

      ctx.fillStyle = "rgba(15, 15, 35, 0.15)"; // trail effect
      ctx.fillRect(0, 0, W, H);

      systemRef.current.update(dt);
      systemRef.current.draw(ctx);

      // Instruction text
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Click anywhere to create explosion", W / 2, H - 16);
      ctx.textAlign = "left";

      frameId = requestAnimationFrame(loop);
    }

    frameId = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frameId);
      canvas.removeEventListener("click", handleClick);
    };
  }, []);

  return <canvas ref={canvasRef} className="block rounded-xl cursor-crosshair border border-gray-700" />;
}
```

### 6. Score Tracking and Game State Management

```tsx
import { useRef, useEffect, useState, useCallback } from "react";

type GameStatus = "idle" | "playing" | "paused" | "gameover";

type GameState = {
  status: GameStatus;
  score: number;
  lives: number;
  level: number;
  highScore: number;
};

const INITIAL_STATE: GameState = {
  status: "idle",
  score: 0,
  lives: 3,
  level: 1,
  highScore: parseInt(localStorage.getItem("highScore") ?? "0", 10),
};

export function GameWithHUD() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameStateRef = useRef<GameState>({ ...INITIAL_STATE });
  const [uiState, setUiState] = useState<GameState>({ ...INITIAL_STATE });
  const frameIdRef = useRef<number>(0);

  // Sync game state ref -> React state for HUD re-renders
  const syncUI = useCallback(() => {
    setUiState({ ...gameStateRef.current });
  }, []);

  const addScore = useCallback((points: number) => {
    const gs = gameStateRef.current;
    gs.score += points;
    if (gs.score > gs.highScore) {
      gs.highScore = gs.score;
      localStorage.setItem("highScore", String(gs.highScore));
    }
    syncUI();
  }, [syncUI]);

  const loseLife = useCallback(() => {
    const gs = gameStateRef.current;
    gs.lives -= 1;
    if (gs.lives <= 0) {
      gs.status = "gameover";
    }
    syncUI();
  }, [syncUI]);

  const startGame = useCallback(() => {
    gameStateRef.current = {
      ...INITIAL_STATE,
      highScore: gameStateRef.current.highScore,
      status: "playing",
    };
    syncUI();
  }, [syncUI]);

  const togglePause = useCallback(() => {
    const gs = gameStateRef.current;
    if (gs.status === "playing") gs.status = "paused";
    else if (gs.status === "paused") gs.status = "playing";
    syncUI();
  }, [syncUI]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = 600;
    const H = 400;
    canvas.width = W;
    canvas.height = H;

    let lastTime = 0;
    let tickAccumulator = 0;

    function loop(ts: number) {
      const dt = Math.min((ts - lastTime) / 1000, 0.05);
      lastTime = ts;

      const gs = gameStateRef.current;

      ctx.fillStyle = "#0f0f23";
      ctx.fillRect(0, 0, W, H);

      if (gs.status === "playing") {
        // Game tick — every second, add score and possibly lose a life (demo)
        tickAccumulator += dt;
        if (tickAccumulator >= 1) {
          tickAccumulator -= 1;
          addScore(10 * gs.level);
          if (Math.random() < 0.1) loseLife();
        }

        // Draw something representing gameplay
        ctx.fillStyle = "#60a5fa";
        ctx.font = "bold 14px monospace";
        ctx.fillText("Game running...", W / 2 - 60, H / 2);
      }

      frameIdRef.current = requestAnimationFrame(loop);
    }

    frameIdRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameIdRef.current);
  }, [addScore, loseLife]);

  const { status, score, lives, level, highScore } = uiState;

  return (
    <div className="relative inline-block">
      <canvas ref={canvasRef} className="block rounded-t-xl" />

      {/* HUD Overlay */}
      <div className="bg-gray-900 rounded-b-xl px-4 py-3 flex items-center gap-6 text-white text-sm">
        <div>
          <span className="text-gray-400">Score</span>
          <p className="font-bold text-lg text-yellow-400">{score.toLocaleString()}</p>
        </div>
        <div>
          <span className="text-gray-400">Best</span>
          <p className="font-bold text-lg text-green-400">{highScore.toLocaleString()}</p>
        </div>
        <div>
          <span className="text-gray-400">Level</span>
          <p className="font-bold text-lg">{level}</p>
        </div>
        <div>
          <span className="text-gray-400">Lives</span>
          <p className="font-bold text-lg">
            {Array.from({ length: lives }).map((_, i) => (
              <span key={i} className="text-red-400">♥ </span>
            ))}
            {Array.from({ length: 3 - lives }).map((_, i) => (
              <span key={i} className="text-gray-600">♥ </span>
            ))}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {status === "idle" || status === "gameover" ? (
            <button
              onClick={startGame}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold hover:bg-blue-700 transition"
            >
              {status === "gameover" ? "Retry" : "Start"}
            </button>
          ) : (
            <button
              onClick={togglePause}
              className="rounded-lg bg-gray-700 px-4 py-1.5 text-sm font-semibold hover:bg-gray-600 transition"
            >
              {status === "paused" ? "Resume" : "Pause"}
            </button>
          )}
        </div>
      </div>

      {/* Game over overlay */}
      {status === "gameover" && (
        <div className="absolute inset-0 rounded-t-xl flex flex-col items-center justify-center
          bg-black/70 backdrop-blur-sm">
          <h2 className="text-3xl font-black text-white mb-1">GAME OVER</h2>
          <p className="text-yellow-400 text-xl font-bold mb-2">Score: {score.toLocaleString()}</p>
          {score >= highScore && score > 0 && (
            <p className="text-green-400 text-sm font-semibold mb-4">New High Score!</p>
          )}
          <button
            onClick={startGame}
            className="rounded-xl bg-blue-600 px-8 py-3 text-base font-bold text-white hover:bg-blue-700 transition"
          >
            Play Again
          </button>
        </div>
      )}

      {status === "paused" && (
        <div className="absolute inset-0 rounded-t-xl flex flex-col items-center justify-center
          bg-black/50 backdrop-blur-sm">
          <h2 className="text-2xl font-black text-white mb-4">PAUSED</h2>
          <button
            onClick={togglePause}
            className="rounded-xl bg-white px-8 py-3 text-base font-bold text-gray-900 hover:bg-gray-100 transition"
          >
            Resume
          </button>
        </div>
      )}
    </div>
  );
}
```

### 7. Simple Sprite Rendering

```tsx
// Sprite sheet renderer — assumes a horizontal strip of frames
type SpriteConfig = {
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  fps: number;
};

class AnimatedSprite {
  private frame = 0;
  private elapsed = 0;
  private image: HTMLImageElement | null = null;
  private loaded = false;

  constructor(
    private src: string,
    private config: SpriteConfig
  ) {
    const img = new Image();
    img.onload = () => {
      this.image = img;
      this.loaded = true;
    };
    img.src = src;
  }

  update(dt: number) {
    this.elapsed += dt;
    if (this.elapsed >= 1 / this.config.fps) {
      this.elapsed -= 1 / this.config.fps;
      this.frame = (this.frame + 1) % this.config.frameCount;
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    scale = 1,
    flipX = false
  ) {
    if (!this.loaded || !this.image) {
      // Placeholder while loading
      ctx.fillStyle = "#6366f1";
      ctx.fillRect(
        x - (this.config.frameWidth * scale) / 2,
        y - (this.config.frameHeight * scale) / 2,
        this.config.frameWidth * scale,
        this.config.frameHeight * scale
      );
      return;
    }

    const { frameWidth, frameHeight } = this.config;
    const srcX = this.frame * frameWidth;

    ctx.save();
    ctx.translate(x, y);
    if (flipX) ctx.scale(-1, 1);
    ctx.drawImage(
      this.image,
      srcX, 0,
      frameWidth, frameHeight,
      -(frameWidth * scale) / 2,
      -(frameHeight * scale) / 2,
      frameWidth * scale,
      frameHeight * scale
    );
    ctx.restore();
  }
}

// Usage in a game loop:
// const sprite = new AnimatedSprite("/sprites/player.png", {
//   frameWidth: 48,
//   frameHeight: 48,
//   frameCount: 8,
//   fps: 12,
// });
// In update: sprite.update(dt);
// In render: sprite.draw(ctx, player.x, player.y, 2, player.facingLeft);
```

## Common Mistakes

- **Do not use `useState` for game entities** — state changes trigger React re-renders mid-frame; always use `useRef` for anything the game loop reads or writes
- **Do not forget to cancel `requestAnimationFrame` on cleanup** — the loop keeps running after the component unmounts, causing memory leaks and errors
- **Do not skip delta time** — using a fixed step (like +1 per frame) makes the game run at different speeds on 30fps vs 144fps displays
- **Do not call `ctx.save()`/`ctx.restore()` excessively** — they're relatively expensive; batch similar draw calls instead
- **Do not use `Math.sqrt` in hot collision loops** — compare squared distances instead: `dx*dx + dy*dy < r*r`
- **Do not `clearRect` to a solid color every frame unnecessarily** — if you want a trail effect, fill with a translucent color instead
- **Do not put the `<canvas>` inside a scrollable container without `display: block`** — canvas has extra inline baseline spacing by default that causes scroll jitter

## Framework-Specific Notes

### Next.js

- Canvas game components must be marked `"use client"` — `requestAnimationFrame`, `document`, and `window` are not available in Server Components
- For SSR compatibility, wrap any `localStorage` access (high scores) in `typeof window !== "undefined"` checks or access it only inside `useEffect`
- Use `next/dynamic` with `{ ssr: false }` when importing heavy game modules to avoid SSR bundle bloat

```tsx
const GameCanvas = dynamic(() => import("@/components/GameCanvas"), { ssr: false });
```

### React + Vite

- Vite's hot module replacement can cause the game loop to duplicate on hot reload — always return a cleanup function from `useEffect` that calls `cancelAnimationFrame`
- For asset loading, put sprite sheets in `public/` and reference them as `/sprites/player.png` — Vite copies public assets directly
- Use `import.meta.glob` for dynamically loading multiple sprite files: `import.meta.glob("/public/sprites/*.png")`
