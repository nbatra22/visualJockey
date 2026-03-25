/**
 * AI VJ TOOL — app.js
 * ────────────────────
 * This file owns:
 *   - Global State
 *   - VisualLanguage interpreter (shared by all renderers)
 *   - Gemini API call + schema
 *   - applyParams() — maps Gemini output → State
 *   - Audio init + update loop
 *   - switchMode() — delegates to renderer files
 *   - All UI event listeners
 *
 * Renderer files (loaded before this in index.html):
 *   renderer-particles.js  → initParticlesRenderer()
 *   renderer-blob.js       → initBlobRenderer()
 *   renderer-waveform.js   → initWaveformRenderer(mode)
 */

const GEMINI_API_KEY = (typeof CONFIG !== 'undefined') ? CONFIG.GEMINI_API_KEY : '';

// ─── Global State ─────────────────────────────────────────────────────────────
// All renderers read from this object. Never write to it from renderer files.
const State = {
    mode: 'particles',
    lastPrompt: '',          // remembered so Regenerate works without re-typing
    audioContext: null,
    analyser: null,
    audioSource: null,
    audioData: { bass: 0, mids: 0, highs: 0, raw: [] },
    strobeThreshold: 0.82,
    currentRenderer: null,

    // Numeric params — intensity, density, complexity, palette
    params: {
        palette:         ["#00f2ff", "#7000ff", "#ff007b"],
        motion:          "wave",
        style:           "glitch",
        intensity:       0.7,
        particleDensity: 0.5,
        shapeComplexity: 0.5
    },

    // Visual language fields — set by Gemini, read by VisualLanguage helpers
    visual: {
        motionStyle:    "wave",              // fluid | orbital | chaotic | wave | vortex
        colorStyle:     "neon",              // neon | pastel | monochrome | iridescent
        composition:    "spiral",            // spiral | sphere | galaxy | dna | lissajous | burst | torus | scattered | expanding | symmetric
        effects:        ["glow", "trails"],  // glow | trails | distortion | pulse
        rhythmResponse: "balanced"           // bass-heavy | balanced | high-reactive
    },

    // UI slider values — updated by sliders + applyParams()
    ui: { responsivity: 1.0, chaos: 0.5, energy: 0.5 }
};

// ─── VisualLanguage Interpreter ───────────────────────────────────────────────
// Shared utility object. Renderer files call these — they never compute
// motionStyle/colorStyle/composition logic themselves.
const VisualLanguage = {

    /** Returns audio multipliers based on rhythmResponse */
    getRhythmMults() {
        switch (State.visual.rhythmResponse) {
            case 'bass-heavy':    return { bass: 2.2, mids: 0.5, highs: 0.3 };
            case 'high-reactive': return { bass: 0.4, mids: 0.8, highs: 2.5 };
            case 'balanced':
            default:              return { bass: 1.0, mids: 1.0, highs: 1.0 };
        }
    },

    /** Returns audio clamped to [0,1] after rhythmResponse scaling */
    getScaledAudio() {
        const m = this.getRhythmMults();
        return {
            bass:  Math.min(1, State.audioData.bass  * m.bass),
            mids:  Math.min(1, State.audioData.mids  * m.mids),
            highs: Math.min(1, State.audioData.highs * m.highs)
        };
    },

    /** Returns true if the named effect is in State.visual.effects */
    hasEffect(name) {
        return State.visual.effects.includes(name);
    },

    /**
     * Returns Three.js uniform values driven by visual language.
     * Used by renderer-particles.js each frame.
     */
    getThreeUniforms() {
        const jitter = ['chaotic', 'wave'].includes(State.visual.motionStyle)
            ? State.ui.chaos
            : 0.05;
        const spread = {
            scattered: 1.5,
            expanding: 1.2
        }[State.visual.composition] ?? State.params.particleDensity;
        return { jitter, spread };
    }
};

// ─── Gemini API ───────────────────────────────────────────────────────────────
/**
 * Sends the user's creative prompt to Gemini and returns a visual config object.
 * Returns null on failure (caller should keep existing State.params).
 *
 * Schema returned:
 * {
 *   palette:         [hex, hex, hex]
 *   motionStyle:     "fluid | orbital | chaotic | wave | vortex"
 *   colorStyle:      "neon | pastel | monochrome | iridescent"
 *   composition:     "centered | scattered | symmetric | expanding"
 *   effects:         ["glow", "trails", "distortion", "pulse"]  (1-3 items)
 *   rhythmResponse:  "bass-heavy | balanced | high-reactive"
 *   intensity:       0.0-1.0
 *   particleDensity: 0.0-1.0
 *   shapeComplexity: 0.0-1.0
 * }
 */
async function fetchVisualParams(prompt) {
    const systemPrompt = `You are a VJ intelligence that translates creative prompts into precise visual configurations.
Return ONLY a JSON object — no markdown, no explanation, no backticks.

Schema:
{
  "palette": ["#hex1", "#hex2", "#hex3"],
  "motionStyle": "fluid | orbital | chaotic | wave | vortex",
  "colorStyle": "neon | pastel | monochrome | iridescent",
  "composition": "centered | scattered | symmetric | expanding",
  "effects": ["glow", "trails", "distortion", "pulse"],
  "rhythmResponse": "bass-heavy | balanced | high-reactive",
  "intensity": 0.0-1.0,
  "particleDensity": 0.0-1.0,
  "shapeComplexity": 0.0-1.0
}

Rules:
- palette: REQUIRED — 3 hex colors that are unmistakably tied to the prompt's mood/subject.
    Pick a PRIMARY color that defines the whole look, then 2 supporting colors in the same family.
    The primary color (palette[0]) should be the most dominant and saturated.
    Never use default purple/pink/yellow unless the prompt explicitly calls for them.
    Examples:
      "ocean"       → ["#0af0e0", "#0055cc", "#00ffaa"]   (teals, deep blue, aqua)
      "fire"        → ["#ff4400", "#ffaa00", "#ff0022"]   (orange-red, amber, crimson)
      "forest"      → ["#22ff88", "#005533", "#aaff44"]   (bright green, dark green, lime)
      "midnight"    → ["#4400ff", "#0011aa", "#8800ff"]   (deep violet, navy, purple)
      "rave"        → ["#ff00cc", "#00ffcc", "#ffff00"]   (hot pink, acid green, yellow)
      "glitch"      → ["#00ffff", "#ff00ff", "#ffffff"]   (cyan, magenta, white)
      "blood moon"  → ["#ff2200", "#880000", "#ff6600"]   (red, dark red, orange)
    Always make colors vivid and high-contrast. Muted/grey palettes only if prompt says "fog", "ash", "ghost", etc.
    NEVER use black or near-black (e.g. #000000, #111111, #0a0a0a) — the background is already black so black particles are invisible.
- motionStyle: REQUIRED — must always be chosen. Pick the one that matches the emotional energy of the prompt.
    fluid   = calm, meditative, liquid, dreamy, underwater, ambient → gentle drifting particles
    orbital = cosmic, celestial, planets, orbits, gravity, rotation → circular sweeping paths
    chaotic = glitch, broken, storm, panic, noise, industrial, punk → particles shake apart
    wave    = music, rhythm, pulse, beach, signal, frequency, radio → rippling sine motion
    vortex  = hypnotic, spiral, drain, black hole, trance, spinning → inward/outward pull
    Mood anchors (use as reference, not hard rules):
      "ocean" → fluid, "rave" → chaotic or wave, "galaxy" → orbital,
      "meditation" → fluid or orbital, "glitch" → chaotic, "heartbeat" → wave,
      "black hole" → vortex, "forest wind" → fluid, "lightning" → chaotic
- colorStyle: REQUIRED — must always be chosen.
    neon        = electric, club, cyber, bright, vivid prompts
    pastel      = soft, dreamlike, kawaii, gentle, watercolor prompts
    iridescent  = oil slick, holographic, prism, soap bubble, aurora prompts
    monochrome  = minimal, noir, ghost, fog, architectural prompts
- composition (particle cloud shape — subtle density hint, not a wireframe):
    spiral     = coil / helix energy (default, works with most prompts)
    sphere     = cosmic, planet, bubble, atom, orb prompts
    galaxy     = space, milky way, cosmic dust, nebula prompts
    dna        = biological, science, genetic, tech, helix prompts
    lissajous  = harmonic, frequency, signal, waveform, math prompts
    burst      = explosion, firework, radiant, sun, impact prompts
    torus      = portal, donut, ring, loop, infinity prompts
- effects: choose 1-3. Always include at least one.
    glow       = additive blending — neon/cosmic prompts, overlapping particles bloom
    trails     = long motion blur — fast motion, streaks, comet, speed prompts
    distortion = noise warp — glitch, corruption, heat, mirage prompts
    pulse      = size beats with bass — music, heartbeat, dance, bass-heavy prompts
- rhythmResponse:
    bass-heavy   = kicks dominate (x2.2 bass multiplier)
    balanced     = all bands equal
    high-reactive = hats/highs dominate (x2.5 highs multiplier)
- intensity: 0=subtle audio response, 1=explosive
- particleDensity: 0=sparse, 1=dense cloud
- shapeComplexity: 0=simple, 1=intricate`;

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: `${systemPrompt}\n\nUser prompt: "${prompt}"` }] }]
                })
            }
        );
        const data    = await response.json();
        const rawText = data.candidates[0].content.parts[0].text;
        const cleaned = rawText.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned.match(/\{[\s\S]*\}/)[0]);
    } catch (e) {
        console.error('Gemini fetch failed:', e);
        return null;
    }
}

// ─── Apply Params ─────────────────────────────────────────────────────────────
/**
 * Merges a Gemini response object into State.params and State.visual,
 * then derives ui slider values from the visual language fields.
 * Also syncs the HTML sliders to reflect the AI's intent.
 */
function applyParams(p) {
    // Numeric params
    Object.assign(State.params, {
        palette:         p.palette         || State.params.palette,
        intensity:       p.intensity       ?? State.params.intensity,
        particleDensity: p.particleDensity ?? State.params.particleDensity,
        shapeComplexity: p.shapeComplexity ?? State.params.shapeComplexity
    });

    // Visual language fields
    Object.assign(State.visual, {
        motionStyle:    p.motionStyle    || State.visual.motionStyle,
        colorStyle:     p.colorStyle     || State.visual.colorStyle,
        composition:    p.composition    || State.visual.composition,
        effects:        p.effects        || State.visual.effects,
        rhythmResponse: p.rhythmResponse || State.visual.rhythmResponse
    });

    // Gemini's motionStyle presets chaos; intensity presets responsivity; energy stays mid
    // Users can override any of these live with the sliders after Gemini sets them
    const CHAOS_PRESET = {
        fluid:   0.2,
        orbital: 0.3,
        vortex:  1.0,
        chaotic: 1.8,
        wave:    0.5
    };

    State.ui.chaos        = CHAOS_PRESET[p.motionStyle] ?? 0.5;
    State.ui.responsivity = 0.4 + (p.intensity ?? 0.7) * 1.2;  // 0.4 (subtle) → 1.6 (explosive)
    State.ui.energy       = 0.3 + (p.intensity ?? 0.7) * 0.7;  // 0.3 (calm) → 1.0 (active)

    // Sync HTML sliders to reflect Gemini's choices
    document.getElementById('param-responsivity').value = State.ui.responsivity;
    document.getElementById('param-chaos').value        = State.ui.chaos;
    document.getElementById('param-energy').value       = State.ui.energy;

    // Update status label
    const label = `${State.visual.motionStyle} · ${State.visual.colorStyle} · [${State.visual.effects.join(', ')}]`;
    document.getElementById('current-style-name').textContent = `Style: ${label}`;
}

// ─── Audio ────────────────────────────────────────────────────────────────────
async function initAudio(type) {
    State.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    State.analyser     = State.audioContext.createAnalyser();
    State.analyser.fftSize = 256;

    let audio;
    if (type === 'mic') {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        State.audioSource = State.audioContext.createMediaStreamSource(stream);
    } else {
        const path = document.getElementById('audio-select').value;
        audio = new Audio(path);
        audio.loop = true;
        audio.play();
        State.audioSource = State.audioContext.createMediaElementSource(audio);
    }

    if (State.audioSource) State.audioSource.connect(State.analyser);
    if (type !== 'mic')    State.analyser.connect(State.audioContext.destination);

    updateAudioData();
}

function updateAudioData() {
    if (!State.analyser) return;
    const data = new Uint8Array(State.analyser.frequencyBinCount);
    State.analyser.getByteFrequencyData(data);
    State.audioData.bass  = data.slice(0,  10).reduce((a,b) => a+b, 0) / 10  / 255;
    State.audioData.mids  = data.slice(10, 50).reduce((a,b) => a+b, 0) / 40  / 255;
    State.audioData.highs = data.slice(50,100).reduce((a,b) => a+b, 0) / 50  / 255;
    State.audioData.raw   = data;
    requestAnimationFrame(updateAudioData);
}

// ─── Mode Switching ───────────────────────────────────────────────────────────
/**
 * Tears down the current renderer and starts a new one.
 * Shaders and geometries rebuild here, so Gemini style changes take effect
 * on the next switchMode() call (triggered by Regenerate or manual tab switch).
 */
function switchMode(newMode) {
    if (State.currentRenderer) {
        if (State.currentRenderer.remove)  State.currentRenderer.remove();   // p5 instance
        if (State.currentRenderer.destroy) State.currentRenderer.destroy();  // Three.js
    }
    document.getElementById('canvas-container').innerHTML = '';
    State.mode = newMode;

    if      (newMode === 'particles')                        State.currentRenderer = initParticlesRenderer();
    else if (newMode === 'blob')                             State.currentRenderer = initBlobRenderer();
    else if (newMode === 'waves' || newMode === 'shape')     State.currentRenderer = initWaveformRenderer(newMode);
}

// ─── UI Event Listeners ───────────────────────────────────────────────────────

// Start — fetch Gemini params if prompt given, init audio, launch
document.getElementById('start-btn').addEventListener('click', async () => {
    const prompt    = document.getElementById('visual-prompt').value.trim();
    const audioMode = document.getElementById('audio-select').dataset.mode || 'select';
    const btn       = document.getElementById('start-btn');

    if (prompt) {
        State.lastPrompt    = prompt;
        btn.textContent = 'Reading your vibe...';
        btn.disabled    = true;
        const aiParams  = await fetchVisualParams(prompt);
        if (aiParams) applyParams(aiParams);
        btn.textContent = 'START VISUALIZING';
        btn.disabled    = false;
    }

    if (audioMode === 'mic') await initAudio('mic');
    else                     await initAudio('select');

    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('vj-screen').classList.remove('hidden');
    switchMode('particles');
});

// Back
document.getElementById('back-btn').addEventListener('click', () => location.reload());

// Mode tabs
document.querySelectorAll('.mode-btn').forEach(btn =>
    btn.addEventListener('click', e => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        switchMode(e.target.dataset.mode);
    })
);

// Regenerate — re-fetch Gemini and restart renderer so shaders rebuild
document.getElementById('regen-btn').addEventListener('click', async () => {
    const typed  = document.getElementById('visual-prompt')?.value?.trim() || '';
    const prompt = typed || State.lastPrompt;

    if (!prompt) {
        document.getElementById('current-style-name').textContent = 'Style: type a prompt first';
        return;
    }

    if (typed) State.lastPrompt = typed;  // update memory if user typed something new

    const btn       = document.getElementById('regen-btn');
    btn.textContent = 'Thinking...';
    btn.disabled    = true;

    const aiParams = await fetchVisualParams(prompt);
    if (aiParams) {
        applyParams(aiParams);
        switchMode(State.mode);
    }

    btn.textContent = 'Regenerate Style';
    btn.disabled    = false;
});

// Audio source toggles
function setAudioMode(mode) {
    document.getElementById('audio-select').dataset.mode = mode;
    document.querySelectorAll('.audio-source-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('select-panel').classList.add('hidden');
    if (mode === 'mic') {
        document.getElementById('mic-toggle').classList.add('active');
    } else {
        document.getElementById('select-toggle').classList.add('active');
        document.getElementById('select-panel').classList.remove('hidden');
    }
}
document.getElementById('mic-toggle').addEventListener('click',    () => setAudioMode('mic'));
document.getElementById('select-toggle').addEventListener('click', () => setAudioMode('select'));

// Sliders — write directly to State.ui, renderers read every frame
document.getElementById('param-responsivity').addEventListener('input', e => State.ui.responsivity = parseFloat(e.target.value));
document.getElementById('param-chaos').addEventListener('input',        e => State.ui.chaos         = parseFloat(e.target.value));
document.getElementById('param-energy').addEventListener('input',       e => State.ui.energy        = parseFloat(e.target.value));

// How I Built This — tap to toggle on mobile (no hover on touch)
document.querySelector('.how-built-label').addEventListener('click', () => {
    if (window.innerWidth <= 600) {
        document.getElementById('how-built').classList.toggle('open');
    }
});

// Fullscreen
document.getElementById('fullscreen-btn').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
});