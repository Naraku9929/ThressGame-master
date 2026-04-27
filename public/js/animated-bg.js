
// =============================================================================
// ANIMATED BACKGROUNDS
// =============================================================================
//
// Available effects (1–4):
//
//   1 = Floating Embers      Glowing particles drift upward with gentle sway
//   2 = Aurora Waves          Smooth flowing color bands (pure CSS keyframes)
//   3 = Plasma Flow           Psychedelic shifting colors (Balatro-inspired)
//   4 = Star Tunnel           Stars streaming outward from center
//
// PAGE_BACKGROUND  - always-on background behind the entire page (0 = off)
// PANEL_BACKGROUND - background shown behind the new-rules panel during choice
//
// =============================================================================

const PAGE_BACKGROUND  = 1;   // 0 to disable, 1–4 to pick an effect
const PANEL_BACKGROUND = 4;   // 0 to disable, 1–4 to pick an effect

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

const EFFECTS = {
    1: createFloatingEmbers,
    2: createAuroraWaves,
    3: createPlasmaFlow,
    4: createStarTunnel,
};

function launchEffect(container, effectNum) {
    const bgLayer = document.createElement('div');
    bgLayer.className = 'new-rules-bg';
    container.insertBefore(bgLayer, container.firstChild);

    const create = EFFECTS[effectNum];
    if (!create) return null;

    const destroy = create(bgLayer);
    return () => {
        destroy();
        bgLayer.remove();
    };
}

// -----------------------------------------------------------------------------
// Page-level background (always on)
// -----------------------------------------------------------------------------

let pageCleanup = null;

/** Start a persistent animated background on the given element (e.g. document.body). */
export function startPageBackground(container, effectNum = PAGE_BACKGROUND) {
    stopPageBackground();
    if (!effectNum) return;
    pageCleanup = launchEffect(container, effectNum);
}

/** Stop and remove the page-level background. */
export function stopPageBackground() {
    if (pageCleanup) {
        pageCleanup();
        pageCleanup = null;
    }
}

// -----------------------------------------------------------------------------
// Panel background (new-rules chooser)
// -----------------------------------------------------------------------------

let panelCleanup = null;

/** Start the animated background inside the new-rules panel. */
export function startBackground(container, effectNum = PANEL_BACKGROUND) {
    stopBackground();
    if (!effectNum) return;
    panelCleanup = launchEffect(container, effectNum);
}

/** Stop and remove the panel background. */
export function stopBackground() {
    if (panelCleanup) {
        panelCleanup();
        panelCleanup = null;
    }
}

// =============================================================================
// EFFECT 1 - FLOATING EMBERS
// =============================================================================
// Glowing particles drift upward with gentle horizontal sway.
// Colors drawn from the app's green / gold / muted-red palette.

function createFloatingEmbers(container) {
    const COUNT = 85;
    const W = container.clientWidth || 300;
    const H = container.clientHeight || 600;

    const COLORS = [
        { r: 129, g: 182, b: 76 },   // accent green
        { r: 163, g: 209, b: 96 },   // light green
        { r: 98,  g: 153, b: 36 },   // dim green
        { r: 225,  g: 225, b: 222 },   // white
        { r: 165,  g: 181, b: 163 },   // gray
    ];

    const particles = [];

    for (let i = 0; i < COUNT; i++) {
        const el = document.createElement('div');
        const size = 2 + Math.random() * 7;
        const c = COLORS[Math.floor(Math.random() * COLORS.length)];
        const glow = `rgba(${c.r},${c.g},${c.b},0.6)`;

        Object.assign(el.style, {
            position: 'absolute',
            width: `${size}px`,
            height: `${size}px`,
            borderRadius: '50%',
            background: `rgba(${c.r},${c.g},${c.b},0.8)`,
            boxShadow: `0 0 ${size * 3}px ${glow}, 0 0 ${size * 6}px ${glow}`,
            willChange: 'transform, opacity',
        });

        container.appendChild(el);
        particles.push({
            el,
            x: Math.random() * W,
            y: Math.random() * H,
            speed: 0.3 + Math.random() * 0.8,
            phase: Math.random() * Math.PI * 2,
            drift: 0.005 + Math.random() * 0.012,
            sway: 15 + Math.random() * 30,
            oPhase: Math.random() * Math.PI * 2,
            oSpeed: 0.003 + Math.random() * 0.008,
        });
    }

    let running = true;
    let raf;

    const tick = () => {
        if (!running) return;

        for (const p of particles) {
            p.y -= p.speed;
            p.phase += p.drift;
            p.oPhase += p.oSpeed;

            if (p.y < -20) {
                p.y = H + 10;
                p.x = Math.random() * W;
            }

            const ox = Math.sin(p.phase) * p.sway;
            const alpha = Math.sin(p.oPhase) * 0.35 + 0.45;

            p.el.style.transform = `translate(${p.x + ox}px, ${p.y}px)`;
            p.el.style.opacity = alpha;
        }

        raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
        running = false;
        cancelAnimationFrame(raf);
        particles.forEach(p => p.el.remove());
    };
}

// =============================================================================
// EFFECT 2 - AURORA WAVES
// =============================================================================
// Large, blurred gradient blobs drift and morph via CSS keyframes.
// Colors: green, teal, gold, purple - pure CSS, no JS animation loop.

function createAuroraWaves(container) {
    const uid = `nrbg-${Date.now()}`;

    const styleEl = document.createElement('style');
    styleEl.textContent = `
        @keyframes ${uid}-d1 {
            0%   { transform: translateX(-30%) translateY(-20%) rotate(-5deg) scale(1.2); }
            33%  { transform: translateX(20%)  translateY(10%)  rotate(3deg)  scale(1.0); }
            66%  { transform: translateX(-10%) translateY(-5%)  rotate(-2deg) scale(1.3); }
            100% { transform: translateX(-30%) translateY(-20%) rotate(-5deg) scale(1.2); }
        }
        @keyframes ${uid}-d2 {
            0%   { transform: translateX(20%)  translateY(10%)  rotate(8deg)  scale(1.1); }
            33%  { transform: translateX(-20%) translateY(-15%) rotate(-4deg) scale(1.3); }
            66%  { transform: translateX(10%)  translateY(5%)   rotate(6deg)  scale(0.9); }
            100% { transform: translateX(20%)  translateY(10%)  rotate(8deg)  scale(1.1); }
        }
        @keyframes ${uid}-d3 {
            0%   { transform: translateX(0%)   translateY(20%)  rotate(-3deg) scale(1.0); }
            50%  { transform: translateX(-15%) translateY(-10%) rotate(5deg)  scale(1.2); }
            100% { transform: translateX(0%)   translateY(20%)  rotate(-3deg) scale(1.0); }
        }
        @keyframes ${uid}-d4 {
            0%   { transform: translateX(10%)  translateY(-10%) rotate(2deg)  scale(1.3); }
            50%  { transform: translateX(-25%) translateY(15%)  rotate(-6deg) scale(1.0); }
            100% { transform: translateX(10%)  translateY(-10%) rotate(2deg)  scale(1.3); }
        }
        @keyframes ${uid}-pulse {
            0%   { opacity: 0.25; }
            50%  { opacity: 0.55; }
            100% { opacity: 0.25; }
        }
    `;
    document.head.appendChild(styleEl);

    const bands = [
        {
            bg: 'radial-gradient(ellipse 80% 50% at 30% 40%, rgba(129,182,76,0.35) 0%, transparent 70%)',
            anim: `${uid}-d1 12s ease-in-out infinite, ${uid}-pulse 8s ease-in-out infinite`,
        },
        {
            bg: 'radial-gradient(ellipse 70% 60% at 70% 60%, rgba(41,171,164,0.28) 0%, transparent 70%)',
            anim: `${uid}-d2 15s ease-in-out infinite, ${uid}-pulse 10s ease-in-out infinite 2s`,
        },
        {
            bg: 'radial-gradient(ellipse 90% 40% at 50% 30%, rgba(229,168,41,0.22) 0%, transparent 60%)',
            anim: `${uid}-d3 18s ease-in-out infinite, ${uid}-pulse 7s ease-in-out infinite 1s`,
        },
        {
            bg: 'radial-gradient(ellipse 60% 70% at 40% 70%, rgba(120,60,150,0.22) 0%, transparent 65%)',
            anim: `${uid}-d4 20s ease-in-out infinite, ${uid}-pulse 12s ease-in-out infinite 3s`,
        },
        {
            bg: 'radial-gradient(ellipse 50% 80% at 60% 20%, rgba(129,182,76,0.18) 0%, transparent 60%)',
            anim: `${uid}-d1 25s ease-in-out infinite reverse, ${uid}-pulse 9s ease-in-out infinite 4s`,
        },
    ];

    const els = bands.map(band => {
        const el = document.createElement('div');
        Object.assign(el.style, {
            position: 'absolute',
            inset: '-50%',
            background: band.bg,
            animation: band.anim,
            filter: 'blur(30px)',
            willChange: 'transform, opacity',
        });
        container.appendChild(el);
        return el;
    });

    return () => {
        els.forEach(el => el.remove());
        styleEl.remove();
    };
}

// =============================================================================
// EFFECT 3 - PLASMA FLOW  (Balatro-inspired)
// =============================================================================
// Mathematical plasma rendered on a low-res canvas and stretched to fill.
// Sum-of-sines creates flowing, psychedelic green / teal color patterns.

function createPlasmaFlow(container) {
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
    container.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    const SCALE = 4;
    let W, H, imgData;

    const resize = () => {
        W = Math.ceil((container.clientWidth || 300) / SCALE);
        H = Math.ceil((container.clientHeight || 600) / SCALE);
        canvas.width = W;
        canvas.height = H;
        imgData = ctx.createImageData(W, H);
    };
    resize();

    let running = true;
    let raf;
    let t = 0;

    const tick = () => {
        if (!running) return;
        t += 0.012;

        const data = imgData.data;

        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const nx = x / W;
                const ny = y / H;

                const v1 = Math.sin(nx * 6.0 + t * 0.7);
                const v2 = Math.sin(ny * 8.0 + t * 0.5);
                const v3 = Math.sin((nx + ny) * 5.0 + t * 0.9);
                const v4 = Math.sin(
                    Math.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2) * 10 + t * 1.2
                );
                const v = (v1 + v2 + v3 + v4) / 4; // -1 … 1

                const hue  = 120 + v * 40 + Math.sin(t * 0.3) * 20;
                const sat  = 45  + v * 20;
                const light = 10  + v * 8  + Math.sin(t + nx * 3) * 4;

                const [r, g, b] = hslToRgb(hue / 360, sat / 100, light / 100);
                const idx = (y * W + x) * 4;
                data[idx]     = r;
                data[idx + 1] = g;
                data[idx + 2] = b;
                data[idx + 3] = 210;
            }
        }

        ctx.putImageData(imgData, 0, 0);
        raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
        running = false;
        cancelAnimationFrame(raf);
        canvas.remove();
    };
}

// =============================================================================
// EFFECT 4 - STAR TUNNEL
// =============================================================================
// Perspective-projected stars stream outward from the center with fading trails.

function createStarTunnel(container) {
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
    container.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    let W = container.clientWidth || 300;
    let H = container.clientHeight || 600;
    canvas.width = W;
    canvas.height = H;

    const STAR_COUNT = 300;
    const COLORS = [
        [129, 182, 76],   // green
        [163, 209, 96],   // light green
        // [229, 168, 41],   // gold
        [200, 200, 200],  // silver
        [255, 255, 255],  // white
    ];

    const stars = Array.from({ length: STAR_COUNT }, () => ({
        x:  (Math.random() - 0.5) * W * 2,
        y:  (Math.random() - 0.5) * H * 2,
        z:  Math.random() * W,
        pz: 0,
        ci: Math.floor(Math.random() * COLORS.length),
    }));

    ctx.fillStyle = '#1a1917';
    ctx.fillRect(0, 0, W, H);

    let running = true;
    let raf;
    const speed = 2;

    const tick = () => {
        if (!running) return;

        ctx.fillStyle = 'rgba(26, 25, 23, 0.12)';
        ctx.fillRect(0, 0, W, H);

        const cx = W / 2;
        const cy = H / 2;

        for (const s of stars) {
            s.pz = s.z;
            s.z -= speed;

            if (s.z <= 0.5) {
                s.x  = (Math.random() - 0.5) * W * 2;
                s.y  = (Math.random() - 0.5) * H * 2;
                s.z  = W;
                s.pz = W;
                continue;
            }

            const sx = (s.x / s.z)  * (W * 0.25) + cx;
            const sy = (s.y / s.z)  * (H * 0.25) + cy;
            const px = (s.x / s.pz) * (W * 0.25) + cx;
            const py = (s.y / s.pz) * (H * 0.25) + cy;

            const depth = 1 - s.z / W;
            const size  = Math.max(0.3, depth * 2.5);
            const alpha = depth * 0.75;
            const c = COLORS[s.ci];

            ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha * 0.6})`;
            ctx.lineWidth = size * 0.8;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(sx, sy);
            ctx.stroke();

            ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
            ctx.beginPath();
            ctx.arc(sx, sy, size * 0.6, 0, Math.PI * 2);
            ctx.fill();
        }

        raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
        running = false;
        cancelAnimationFrame(raf);
        canvas.remove();
    };
}

// =============================================================================
// HELPERS
// =============================================================================

function hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) {
        r = g = b = l;
    } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const hue2rgb = (pp, qq, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return pp + (qq - pp) * 6 * t;
            if (t < 1 / 2) return qq;
            if (t < 2 / 3) return pp + (qq - pp) * (2 / 3 - t) * 6;
            return pp;
        };
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
