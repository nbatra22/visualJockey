/**
 * RENDERER: Waveform + Particles (p5.js)
 * ───────────────────────────────────────
 * Reads from: State.visual, State.params, State.ui, State.audioData
 * Entry point: initWaveformRenderer(mode)  — mode: 'waves' | 'shape'
 * Returns: p5 instance (has .remove())
 *
 * WHAT GEMINI CONTROLS HERE:
 *   motionStyle    → wave shape math (fluid/vortex/chaotic/wave) & particle velocity field
 *   colorStyle     → per-particle color derivation (neon/iridescent/pastel/monochrome)
 *   composition    → initial particle spawn positions + per-frame forces
 *   effects.glow   → blendMode(ADD/SCREEN) for additive light mixing
 *   effects.trails → background alpha (long ghost vs fast clear)
 *   effects.distortion → scanline warp overlay in waves mode
 *   effects.pulse  → particle size beats with bass instead of highs
 *   rhythmResponse → scales which frequency band is loudest before drawing
 */

function initWaveformRenderer(mode) {
    // p5 instance mode — returns the p5 object so switchMode can call .remove()
    return new p5((p) => {

        let particles = [];

        // ── Setup ─────────────────────────────────────────────────────────────
        p.setup = () => {
            p.createCanvas(window.innerWidth, window.innerHeight);
            p.colorMode(p.HSB, 360, 100, 100, 1);
            spawnParticles();
        };

        // ── Particle init — composition controls spawn positions ──────────────
        function spawnParticles() {
            const COUNT    = 300;
            const initPos  = getInitialPositions(COUNT, p.width, p.height);
            particles = Array.from({ length: COUNT }, (_, i) => ({
                x:        initPos[i].x,
                y:        initPos[i].y,
                vx:       0,
                vy:       0,
                trail:    [],
                size:     Math.random() * 3 + 1.5,
                colorIdx: Math.floor(Math.random() * State.params.palette.length),
                _idx:     i
            }));
        }

        // ── Main draw loop ────────────────────────────────────────────────────
        p.draw = () => {
            // ── Slider → p5 parameter mapping (waveform) ──────────────────────
            // responsivity: multiplies all audio bands read this frame
            //   0 = flat/deaf   2 = hyper-reactive
            // chaos: drives jitter magnitude + flow field frequency
            //   0 = perfectly smooth paths   2 = particles scatter wildly
            // energy: scales frameCount tick speed (idle animation rate)
            //   0 = very slow drift   1 = full speed
            const bgAlpha = VisualLanguage.hasEffect('trails') ? 0.06 : 0.18;
            p.background(0, 0, 0, bgAlpha);

            if (State.mode === 'waves') drawWaves();
            else                        drawParticles();
        };

        // ─────────────────────────────────────────────────────────────────────
        // DRAW: Particles (shape mode)
        // ─────────────────────────────────────────────────────────────────────
        function drawParticles() {
            // energy scales the frameCount clock so idle motion speed is user-controlled
            const t     = p.frameCount * 0.01 * (0.1 + State.ui.energy * 0.9);
            const rawAudio = VisualLanguage.getScaledAudio();
            // responsivity multiplies all audio bands
            const r = State.ui.responsivity;
            const audio = {
                bass:  Math.min(1, rawAudio.bass  * r),
                mids:  Math.min(1, rawAudio.mids  * r),
                highs: Math.min(1, rawAudio.highs * r),
            };
            // energy also acts as a base motion amplitude multiplier
            const energy = State.ui.energy * State.params.intensity;

            // effects: glow → additive blending makes overlapping trails bloom
            if (VisualLanguage.hasEffect('glow')) p.blendMode(p.ADD);

            particles.forEach((pt) => {

                // ── Motion ────────────────────────────────────────────────────
                const { vx, vy } = getMotionDelta(pt, t, audio, energy, p);
                const { fx, fy } = getCompositionForce(pt, p);

                pt.x += vx + fx;
                pt.y += vy + fy;

                // Screen wrap
                if (pt.x < 0)       pt.x = p.width;
                if (pt.x > p.width) pt.x = 0;
                if (pt.y < 0)       pt.y = p.height;
                if (pt.y > p.height) pt.y = 0;

                // composition: expanding → re-seed at center when particle hits edge
                if (State.visual.composition === 'expanding') {
                    const dx = pt.x - p.width  / 2;
                    const dy = pt.y - p.height / 2;
                    if (Math.sqrt(dx*dx + dy*dy) > Math.min(p.width, p.height) * 0.55) {
                        pt.x     = p.width  / 2 + (Math.random() - 0.5) * 30;
                        pt.y     = p.height / 2 + (Math.random() - 0.5) * 30;
                        pt.trail = [];
                    }
                }

                // ── Trail ─────────────────────────────────────────────────────
                const maxTrail = VisualLanguage.hasEffect('trails') ? 40 : 12;
                pt.trail.push({ x: pt.x, y: pt.y });
                if (pt.trail.length > maxTrail) pt.trail.shift();

                // ── Draw trail line ───────────────────────────────────────────
                const col     = getParticleColor(p, pt, t);
                const glowAlpha = getGlowAlpha();

                p.noFill();
                p.stroke(p.hue(col), p.saturation(col), p.brightness(col), glowAlpha * 0.5);
                p.strokeWeight(1 + audio.mids * 2);
                p.beginShape();
                pt.trail.forEach(pos => p.vertex(pos.x, pos.y));
                p.endShape();

                // ── Draw particle dot ─────────────────────────────────────────
                p.noStroke();
                p.fill(p.hue(col), p.saturation(col), p.brightness(col), glowAlpha);

                // effects: pulse → size beats with bass, otherwise with highs
                const pulseMult = VisualLanguage.hasEffect('pulse')
                    ? 1 + audio.bass  * 3 * energy
                    : 1 + audio.highs * 2 * energy;

                p.ellipse(pt.x, pt.y, pt.size * pulseMult);
            });

            p.blendMode(p.BLEND);
        }

        // ─────────────────────────────────────────────────────────────────────
        // DRAW: Waves (lightshow mode)
        // ─────────────────────────────────────────────────────────────────────
        function drawWaves() {
            if (VisualLanguage.hasEffect('glow')) p.blendMode(p.SCREEN);

            // energy controls idle wave animation speed
            const t      = p.frameCount * 0.02 * (0.1 + State.ui.energy * 0.9);
            const rawAudio = VisualLanguage.getScaledAudio();
            const r = State.ui.responsivity;
            const audio = {
                bass:  Math.min(1, rawAudio.bass  * r),
                mids:  Math.min(1, rawAudio.mids  * r),
                highs: Math.min(1, rawAudio.highs * r),
            };
            const energy = State.ui.energy * State.params.intensity;
            const bandCount = 6 + Math.floor(State.params.shapeComplexity * 6);

            // ── Wave bands — motionStyle controls the curve math ──────────────
            for (let i = 0; i < bandCount; i++) {
                const yBase = (i / bandCount) * p.height;
                const col   = getParticleColor(p, { colorIdx: i % State.params.palette.length, x: 0, y: yBase, _idx: i }, t);

                p.noFill();
                p.stroke(p.hue(col), p.saturation(col), p.brightness(col), 0.25 + audio.mids * 0.5);
                p.strokeWeight(1 + audio.mids * 3);
                p.beginShape();

                for (let x = 0; x <= p.width; x += 14) {
                    p.vertex(x, getWaveY(x, yBase, i, t, audio, energy, p));
                }
                p.endShape();
            }

            // ── Vertical scanlines — driven by highs ──────────────────────────
            const lineCount = 20 + Math.floor(audio.highs * 40);
            for (let i = 0; i < lineCount; i++) {
                const x   = (i / lineCount) * p.width;
                const col = getParticleColor(p, { colorIdx: i % State.params.palette.length, x, y: 0, _idx: i }, t);
                const flicker = Math.sin(t * 10 + i) * 0.5 + 0.5;
                p.stroke(p.hue(col), p.saturation(col), p.brightness(col), 0.1 + flicker * audio.highs * 0.6);
                p.strokeWeight(1);
                p.line(x, 0, x, p.height);
            }

            // ── effects: distortion → horizontal scanline warp overlay ────────
            if (VisualLanguage.hasEffect('distortion')) {
                p.stroke(200, 80, 100, audio.highs * 0.3);
                p.strokeWeight(1);
                for (let y = 0; y < p.height; y += 8) {
                    const xOffset = Math.sin(y * 0.05 + t * 4) * audio.mids * 20;
                    p.line(xOffset, y, p.width + xOffset, y);
                }
            }

            p.blendMode(p.BLEND);
        }

        p.windowResized = () => p.resizeCanvas(window.innerWidth, window.innerHeight);

    }, 'canvas-container');
}

// ─────────────────────────────────────────────────────────────────────────────
// MOTION HELPERS
// Called per-particle per-frame. Isolated here for easy tuning.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns { vx, vy } for a particle based on motionStyle.
 * All styles read p.noise() for Perlin-based flow when relevant.
 */
function getMotionDelta(pt, t, audio, energy, p) {
    const cx = p.width / 2, cy = p.height / 2;

    switch (State.visual.motionStyle) {

        case 'fluid': {
            // Smooth Perlin flow field — low chaos, high coherence
            // energy controls flow field scale (faster clock = tighter field)
            const angle = p.noise(pt.x * scale, pt.y * scale, t * 0.15) * Math.PI * 2;
            const speed = 0.8 + audio.bass * 2.5 * energy;
            return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
        }

        case 'orbital': {
            // Tangent velocity around center + weak centripetal pull
            const dx   = pt.x - cx, dy = pt.y - cy;
            const dist = Math.sqrt(dx*dx + dy*dy) || 1;
            const tx   = -dy / dist, ty = dx / dist; // tangent
            const speed       = (1 + audio.mids * 2) * energy * 0.8;
            const pullStrength = 0.005 + audio.bass * 0.02;
            return {
                vx: tx * speed - dx * pullStrength,
                vy: ty * speed - dy * pullStrength
            };
        }

        case 'vortex': {
            // Spiral inward pull with angular twist
            const dx   = pt.x - cx, dy = pt.y - cy;
            const dist = Math.sqrt(dx*dx + dy*dy) || 1;
            const pull  = (0.015 + audio.bass * 0.06) * energy;
            const twist = 1.8 + audio.mids * 2;
            return {
                vx: (-dx * pull) + (-dy / dist) * twist,
                vy: (-dy * pull) + ( dx / dist) * twist
            };
        }

        case 'chaotic': {
            // Jitter-dominated — high noise frequency + random offset
            const scale  = 0.005;
            const jitter = (Math.random() - 0.5) * (3 + audio.highs * 8) * State.ui.chaos;  // chaos slider
            const angle  = p.noise(pt.x * scale, pt.y * scale, t * 0.4) * Math.PI * 4;
            const speed  = 0.5 + audio.bass * 3 * energy;
            return {
                vx: Math.cos(angle) * speed + jitter,
                vy: Math.sin(angle) * speed + jitter
            };
        }

        case 'wave':
        default: {
            // Perlin flow + sinusoidal swirl — the default feel
            // energy as flow scale is handled via the t clock above
            const baseAngle = p.noise(pt.x * scale, pt.y * scale, t * 0.2) * Math.PI * 2;
            const swirl     = Math.sin(t * 2 + pt._idx * 0.1) * audio.mids * 2;
            const angle     = baseAngle + swirl;
            const speed     = 1 + audio.bass * 4 * energy;
            return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
        }
    }
}

/**
 * Returns { fx, fy } — an extra per-frame outward push for 'expanding' composition.
 * All other compositions return zero force.
 */
function getCompositionForce(pt, p) {
    if (State.visual.composition !== 'expanding') return { fx: 0, fy: 0 };
    const cx = p.width / 2, cy = p.height / 2;
    const dx = pt.x - cx, dy = pt.y - cy;
    const dist = Math.sqrt(dx*dx + dy*dy) || 1;
    return { fx: (dx / dist) * 0.4, fy: (dy / dist) * 0.4 };
}

/**
 * Returns initial positions for all particles based on composition.
 * Mirrors the Three.js version so both renderers start from the same layout logic.
 */
function getInitialPositions(count, width, height) {
    const positions = [];
    const cx = width / 2, cy = height / 2;
    for (let i = 0; i < count; i++) {
        const t = i / count;
        switch (State.visual.composition) {
            case 'scattered':
                positions.push({ x: Math.random() * width, y: Math.random() * height });
                break;
            case 'symmetric': {
                const angle = t * Math.PI * 2;
                const r     = 60 + Math.sin(t * Math.PI * 8) * 80;
                positions.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
                break;
            }
            case 'expanding':
                positions.push({ x: cx + (Math.random()-0.5)*40, y: cy + (Math.random()-0.5)*40 });
                break;
            case 'centered':
            default: {
                const angle = t * Math.PI * 14;
                const r     = 10 + t * 180;
                positions.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
            }
        }
    }
    return positions;
}

// ─────────────────────────────────────────────────────────────────────────────
// WAVE SHAPE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the y position for a single wave band vertex based on motionStyle.
 * Called for every x step in drawWaves().
 */
function getWaveY(x, yBase, bandIdx, t, audio, energy, p) {
    switch (State.visual.motionStyle) {

        case 'vortex': {
            // Bands curve around a central axis — spiral feel
            const cx    = p.width / 2;
            const angle = ((x - cx) / p.width) * Math.PI * 2 + t * 2;
            return yBase + Math.sin(angle + bandIdx) * (25 + audio.mids * 90 * energy);
        }

        case 'chaotic': {
            // Random high-frequency jitter on top of sine
            return yBase
                + Math.sin(x * 0.012 + t * 3 + bandIdx) * (15 + audio.mids * 60 * energy)
                + (Math.random() - 0.5) * audio.highs * 30 * State.ui.chaos;  // chaos slider
        }

        case 'fluid': {
            // Double sine — smooth but layered
            return yBase
                + Math.sin(x * 0.006 + t + bandIdx * 0.8) * (30 + audio.mids * 100 * energy)
                + Math.sin(x * 0.015 + t * 1.5)            * 15;
        }

        case 'orbital': {
            // Wider, slower arcs — like sonar rings
            const phase = (bandIdx / 6) * Math.PI * 2;
            return yBase + Math.sin(x * 0.008 + t * 0.8 + phase) * (20 + audio.bass * 80 * energy);
        }

        case 'wave':
        default:
            return yBase + Math.sin(x * 0.01 + t * 2 + bandIdx) * (20 + audio.mids * 80 * energy);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// COLOR HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a p5 color for a particle based on colorStyle.
 * iridescent: hue shifts continuously with position + time
 * monochrome: strips saturation, keeps brightness
 * pastel:     reduces saturation to ~40%
 * neon:       full palette color as-is
 */
function getParticleColor(p, pt, t) {
    if (State.visual.colorStyle === 'iridescent') {
        const hue = (pt.x * 0.5 + pt.y * 0.3 + t * 30) % 360;
        return p.color(hue, 80, 95);
    }

    const base = p.color(State.params.palette[pt.colorIdx]);

    if (State.visual.colorStyle === 'monochrome') {
        const brightness = (p.brightness(base) + 20) % 100;
        return p.color(0, 0, brightness);
    }

    if (State.visual.colorStyle === 'pastel') {
        return p.color(p.hue(base), 40, 95);
    }

    // neon: full saturation as-is
    return base;
}

/**
 * Returns the base opacity for particle fills based on colorStyle.
 * Neon and iridescent are punchy; pastel is softer.
 */
function getGlowAlpha() {
    switch (State.visual.colorStyle) {
        case 'neon':       return 0.95;
        case 'iridescent': return 0.85;
        case 'pastel':     return 0.60;
        case 'monochrome': return 0.75;
        default:           return 0.80;
    }
}