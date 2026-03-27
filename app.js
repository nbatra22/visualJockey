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

// On localhost: call Gemini directly using the key from config.js
// On Vercel:    call the /api/gemini proxy (key lives server-side, never exposed)
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const GEMINI_URL = IS_LOCAL
    ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`
    : `/api/gemini`;

// ─── Global State ─────────────────────────────────────────────────────────────
const State = {
    mode: 'particles',
    lastPrompt: '',
    audioContext: null,
    analyser: null,
    audioSource: null,
    audioData: { bass: 0, mids: 0, highs: 0, raw: [] },
    strobeThreshold: 0.82,
    currentRenderer: null,

    params: {
        palette:         ["#00f2ff", "#7000ff", "#ff007b"],
        motion:          "wave",
        style:           "glitch",
        intensity:       0.7,
        particleDensity: 0.5,
        shapeComplexity: 0.5
    },

    visual: {
        motionStyle:    "wave",
        colorStyle:     "neon",
        composition:    "spiral",
        effects:        ["glow", "trails"],
        rhythmResponse: "balanced"
    },

    ui: { responsivity: 1.0, chaos: 0.5, energy: 0.5 }
};

// ─── VisualLanguage Interpreter ───────────────────────────────────────────────
const VisualLanguage = {

    getRhythmMults() {
        switch (State.visual.rhythmResponse) {
            case 'bass-heavy':    return { bass: 2.2, mids: 0.5, highs: 0.3 };
            case 'high-reactive': return { bass: 0.4, mids: 0.8, highs: 2.5 };
            case 'balanced':
            default:              return { bass: 1.0, mids: 1.0, highs: 1.0 };
        }
    },

    getScaledAudio() {
        const m = this.getRhythmMults();
        return {
            bass:  Math.min(1, State.audioData.bass  * m.bass),
            mids:  Math.min(1, State.audioData.mids  * m.mids),
            highs: Math.min(1, State.audioData.highs * m.highs)
        };
    },

    hasEffect(name) {
        return State.visual.effects.includes(name);
    },

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
async function fetchVisualParams(prompt) {
    const systemPrompt = `You are a VJ intelligence that translates creative prompts into precise visual configurations.
Return ONLY a JSON object — no markdown, no explanation, no backticks.

Schema:
{
  "palette": ["#hex1", "#hex2", "#hex3"],
  "motionStyle": "fluid | orbital | chaotic | wave | vortex",
  "colorStyle": "neon | pastel | monochrome | iridescent",
  "composition": "spiral | sphere | galaxy | dna | lissajous | burst | torus",
  "effects": ["glow", "trails", "distortion", "pulse"],
  "rhythmResponse": "bass-heavy | balanced | high-reactive",
  "intensity": 0.0-1.0,
  "particleDensity": 0.0-1.0,
  "shapeComplexity": 0.0-1.0
}

Rules:
- palette: REQUIRED — 3 hex colors unmistakably tied to the prompt's mood/subject.
    Pick a PRIMARY color that defines the whole look, then 2 supporting colors in the same family.
    The primary color (palette[0]) should be the most dominant and saturated.
    Never use default purple/pink/yellow unless the prompt explicitly calls for them.
    NEVER use black or near-black (e.g. #000000, #111111) — background is already black.
    Examples:
      "ocean"       → ["#0af0e0", "#0055cc", "#00ffaa"]
      "fire"        → ["#ff4400", "#ffaa00", "#ff0022"]
      "forest"      → ["#22ff88", "#005533", "#aaff44"]
      "midnight"    → ["#4400ff", "#0011aa", "#8800ff"]
      "rave"        → ["#ff00cc", "#00ffcc", "#ffff00"]
      "glitch"      → ["#00ffff", "#ff00ff", "#ffffff"]
      "blood moon"  → ["#ff2200", "#880000", "#ff6600"]
    Always make colors vivid and high-contrast.
- motionStyle: REQUIRED — must always be chosen. Pick the one that matches the emotional energy of the prompt.
    fluid   = calm, meditative, liquid, dreamy, underwater, ambient
    orbital = cosmic, celestial, planets, orbits, gravity, rotation
    chaotic = glitch, broken, storm, panic, noise, industrial, punk
    wave    = music, rhythm, pulse, beach, signal, frequency, radio
    vortex  = hypnotic, spiral, drain, black hole, trance, spinning
    Mood anchors:
      "ocean" → fluid, "rave" → chaotic or wave, "galaxy" → orbital,
      "meditation" → fluid or orbital, "glitch" → chaotic, "heartbeat" → wave,
      "black hole" → vortex, "forest wind" → fluid, "lightning" → chaotic
- colorStyle: REQUIRED — must always be chosen.
    neon        = electric, club, cyber, bright, vivid prompts
    pastel      = soft, dreamlike, kawaii, gentle, watercolor prompts
    iridescent  = oil slick, holographic, prism, soap bubble, aurora prompts
    monochrome  = minimal, noir, ghost, fog, architectural prompts
- composition (particle cloud shape):
    spiral     = coil / helix energy (default)
    sphere     = cosmic, planet, bubble, atom, orb prompts
    galaxy     = space, milky way, cosmic dust, nebula prompts
    dna        = biological, science, genetic, tech, helix prompts
    lissajous  = harmonic, frequency, signal, waveform, math prompts
    burst      = explosion, firework, radiant, sun, impact prompts
    torus      = portal, donut, ring, loop, infinity prompts
- effects: choose 1-3. Always include at least one.
    glow       = additive blending — neon/cosmic prompts
    trails     = long motion blur — speed, comet, streaks prompts
    distortion = noise warp — glitch, corruption, heat prompts
    pulse      = size beats with bass — music, heartbeat, dance prompts
- rhythmResponse:
    bass-heavy    = kicks dominate (x2.2 bass multiplier)
    balanced      = all bands equal
    high-reactive = hats/highs dominate (x2.5 highs multiplier)
- intensity: 0=subtle audio response, 1=explosive
- particleDensity: 0=sparse, 1=dense cloud
- shapeComplexity: 0=simple, 1=intricate`;

    try {
        const response = await fetch(GEMINI_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: `${systemPrompt}\n\nUser prompt: "${prompt}"` }] }]
            })
        });
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
function applyParams(p) {
    Object.assign(State.params, {
        palette:         p.palette         || State.params.palette,
        intensity:       p.intensity       ?? State.params.intensity,
        particleDensity: p.particleDensity ?? State.params.particleDensity,
        shapeComplexity: p.shapeComplexity ?? State.params.shapeComplexity
    });

    Object.assign(State.visual, {
        motionStyle:    p.motionStyle    || State.visual.motionStyle,
        colorStyle:     p.colorStyle     || State.visual.colorStyle,
        composition:    p.composition    || State.visual.composition,
        effects:        p.effects        || State.visual.effects,
        rhythmResponse: p.rhythmResponse || State.visual.rhythmResponse
    });

    const CHAOS_PRESET = {
        fluid:   0.2,
        orbital: 0.3,
        vortex:  1.0,
        chaotic: 1.8,
        wave:    0.5
    };

    State.ui.chaos        = CHAOS_PRESET[p.motionStyle] ?? 0.5;
    State.ui.responsivity = 0.4 + (p.intensity ?? 0.7) * 1.2;
    State.ui.energy       = 0.3 + (p.intensity ?? 0.7) * 0.7;

    document.getElementById('param-responsivity').value = State.ui.responsivity;
    document.getElementById('param-chaos').value        = State.ui.chaos;
    document.getElementById('param-energy').value       = State.ui.energy;

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
function switchMode(newMode) {
    if (State.currentRenderer) {
        if (State.currentRenderer.remove)  State.currentRenderer.remove();
        if (State.currentRenderer.destroy) State.currentRenderer.destroy();
    }
    document.getElementById('canvas-container').innerHTML = '';
    State.mode = newMode;

    if      (newMode === 'particles')                    State.currentRenderer = initParticlesRenderer();
    else if (newMode === 'blob')                         State.currentRenderer = initBlobRenderer();
    else if (newMode === 'waves' || newMode === 'shape') State.currentRenderer = initWaveformRenderer(newMode);
}

// ─── UI Event Listeners ───────────────────────────────────────────────────────

document.getElementById('start-btn').addEventListener('click', async () => {
    const prompt    = document.getElementById('visual-prompt').value.trim();
    const audioMode = document.getElementById('audio-select').dataset.mode || 'select';
    const btn       = document.getElementById('start-btn');

    if (prompt) {
        State.lastPrompt = prompt;
        btn.textContent  = 'Reading your vibe...';
        btn.disabled     = true;
        const aiParams   = await fetchVisualParams(prompt);
        if (aiParams) applyParams(aiParams);
        btn.textContent  = 'START VISUALIZING';
        btn.disabled     = false;
    }

    if (audioMode === 'mic') await initAudio('mic');
    else                     await initAudio('select');

    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('vj-screen').classList.remove('hidden');
    switchMode('particles');
});

document.getElementById('back-btn').addEventListener('click', () => location.reload());

document.querySelectorAll('.mode-btn').forEach(btn =>
    btn.addEventListener('click', e => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        switchMode(e.target.dataset.mode);
    })
);

document.getElementById('regen-btn').addEventListener('click', async () => {
    const typed  = document.getElementById('visual-prompt')?.value?.trim() || '';
    const prompt = typed || State.lastPrompt;

    if (!prompt) {
        document.getElementById('current-style-name').textContent = 'Style: type a prompt first';
        return;
    }

    if (typed) State.lastPrompt = typed;

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

document.getElementById('param-responsivity').addEventListener('input', e => State.ui.responsivity = parseFloat(e.target.value));
document.getElementById('param-chaos').addEventListener('input',        e => State.ui.chaos         = parseFloat(e.target.value));
document.getElementById('param-energy').addEventListener('input',       e => State.ui.energy        = parseFloat(e.target.value));

document.querySelector('.how-built-label')?.addEventListener('click', (e) => {
    if (window.innerWidth <= 1024) {
        e.stopPropagation();
        document.getElementById('how-built')?.classList.toggle('open');
    }
});

document.addEventListener('click', (e) => {
    const howBuilt = document.getElementById('how-built');
    if (howBuilt && !howBuilt.contains(e.target) && howBuilt.classList.contains('open')) {
        howBuilt.classList.remove('open');
    }
});

document.getElementById('fullscreen-btn').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
});