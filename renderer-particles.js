/**
 * RENDERER: Particles (Three.js GPU particle cloud)
 * ─────────────────────────────────────────────────
 * Reads from: State.visual, State.params, State.ui, State.audioData
 * Entry point: initParticlesRenderer()
 * Returns: { destroy() }
 *
 * TWO INDEPENDENT GLSL MAPS:
 *
 *   SHAPE_GLSL   — sets the rest/base position of every particle.
 *                  Scatter is intentionally large so the mathematical path
 *                  is only a density hint, not a visible line.
 *                  Mapped from State.visual.composition:
 *                    spiral | sphere | galaxy | dna | lissajous | burst | torus
 *
 *   MOTION_GLSL  — animates particles each frame. Always has a non-zero
 *                  idle term so the cloud breathes even with no audio.
 *                  Mapped from State.visual.motionStyle:
 *                    fluid | vortex | orbital | chaotic | wave
 *
 * WHAT GEMINI CONTROLS:
 *   composition    → SHAPE_GLSL block (density silhouette)
 *   motionStyle    → MOTION_GLSL block (animation character)
 *   colorStyle     → vertex color derivation at init
 *   effects.glow   → AdditiveBlending + soft fragment falloff
 *   effects.pulse  → gl_PointSize beats with bass
 *   effects.distortion → extra noise warp
 *   rhythmResponse → scales audio bands before uniforms read them
 */

function initParticlesRenderer() {
    const container = document.getElementById('canvas-container');

    // ── Scene setup ──────────────────────────────────────────────────────────
    const scene    = new THREE.Scene();
    const camera   = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);
    camera.position.z = 6;

    // ── Geometry ──────────────────────────────────────────────────────────────
    const COUNT = 160; // 160×160 = 25,600 particles
    const TOTAL = COUNT * COUNT;

    const positions = new Float32Array(TOTAL * 3);
    const colors    = new Float32Array(TOTAL * 3);

    for (let i = 0; i < COUNT; i++) {
        for (let j = 0; j < COUNT; j++) {
            const idx = i * COUNT + j;
            positions[idx*3+0] = (i / COUNT) * 6 - 3;
            positions[idx*3+1] = (j / COUNT) * 6 - 3;
            positions[idx*3+2] = 0;

            const rawColor = new THREE.Color(State.params.palette[(i + j) % State.params.palette.length]);
            const c = deriveThreeColor(rawColor, i, j);
            colors[idx*3+0] = c.r;
            colors[idx*3+1] = c.g;
            colors[idx*3+2] = c.b;
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

    // ─────────────────────────────────────────────────────────────────────────
    // SHAPE MAP
    // Each block places particles using `aT` (0→1 per particle).
    // Scatter radius is kept large — the shape is a density gradient,
    // not a visible wireframe path. Particles should read as a cloud.
    //
    // To add a shape: add a key here + add it to Gemini's composition list
    // in app.js. No other changes needed.
    // ─────────────────────────────────────────────────────────────────────────
    const SHAPE_GLSL = {

        // Spiral — wide scatter makes path invisible, fills whole frame
        spiral: `
            float turns   = 4.0;
            float angle   = aT * turns * 6.28318;
            float r       = aT * 5.5;
            float scatter = 1.2 + sin(aT * 317.3) * 0.9 + cos(aT * 591.1) * 0.6;
            float sAngle  = aT * 137.508 * 6.28318;
            pos = vec3(
                cos(angle) * r + cos(sAngle) * scatter,
                sin(angle) * r + sin(sAngle) * scatter,
                sin(aT * 47.0) * 2.0 + cos(aT * 131.0) * 1.2
            );
        `,

        // Sphere — volumetric fill, radius varies per particle
        sphere: `
            float golden = 2.39996;
            float phi    = acos(1.0 - 2.0 * aT);
            float theta  = golden * aT * float(${TOTAL});
            float r      = 1.5 + sin(aT * 291.7) * 2.2;
            pos = vec3(
                r * sin(phi) * cos(theta),
                r * sin(phi) * sin(theta),
                r * cos(phi)
            );
        `,

        // Galaxy — wide arms, heavy scatter, fills the frame
        galaxy: `
            float arms     = 3.0;
            float armAngle = aT * 6.28318 * arms;
            float r        = 0.3 + aT * 5.0;
            float twist    = r * 1.2;
            float angle    = armAngle + twist;
            float scatter  = (sin(aT * 431.7) * 0.5 + 0.5) * 1.8;
            float sAngle   = aT * 239.0;
            pos = vec3(
                cos(angle) * r + cos(sAngle) * scatter,
                sin(angle) * r + sin(sAngle) * scatter,
                (sin(aT * 173.0) - 0.5) * 1.5
            );
        `,

        // DNA — two wide helices filling vertical space
        dna: `
            float strand  = step(0.5, fract(aT * 2.0));
            float t2      = fract(aT * 2.0);
            float z       = (aT - 0.5) * 9.0;
            float angle   = t2 * 6.28318 * 4.0 + strand * 3.14159;
            float r       = 1.2;
            float scatter = 0.7 + sin(aT * 431.0) * 0.5;
            float sAngle  = aT * 251.3 * 6.28318;
            pos = vec3(
                cos(angle) * r + cos(sAngle) * scatter,
                sin(angle) * r + sin(sAngle) * scatter,
                z
            );
        `,

        // Lissajous — large figure-8 cloud covering the frame
        lissajous: `
            float a       = 3.0;
            float b       = 2.0;
            float delta   = 1.5708;
            float angle   = aT * 6.28318;
            float scatter = 1.0 + sin(aT * 271.3) * 0.7;
            float sAngle  = aT * 193.7 * 6.28318;
            pos = vec3(
                3.8 * sin(a * angle + delta) + cos(sAngle) * scatter,
                3.8 * sin(b * angle)         + sin(sAngle) * scatter,
                sin(angle * 5.0) * 2.0 + cos(aT * 317.0) * 0.8
            );
        `,

        // Burst — spokes reach screen edges, wide perpendicular scatter
        burst: `
            float spokes  = 24.0;
            float spoke   = floor(aT * spokes);
            float along   = fract(aT * spokes);
            float angle   = (spoke / spokes) * 6.28318;
            float r       = along * 5.5;
            float scatter = (sin(aT * 379.1) * 0.5 + 0.5) * (r * 0.5 + 0.8);
            pos = vec3(
                cos(angle) * r + sin(angle + 1.5708) * scatter,
                sin(angle) * r - cos(angle + 1.5708) * scatter,
                sin(aT * 211.0) * 1.8
            );
        `,

        // Torus — large donut with volumetric scatter
        torus: `
            float R   = 2.8;
            float u   = aT * 6.28318 * float(${TOTAL} / 40);
            float v   = fract(sin(aT * 7919.0) * 43758.5) * 6.28318;
            float r2  = 1.1 + sin(aT * 293.1) * 0.6;
            pos = vec3(
                (R + r2 * cos(v)) * cos(u),
                (R + r2 * cos(v)) * sin(u),
                r2 * sin(v)
            );
        `,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // MOTION MAP
    // Every block has TWO terms:
    //   1. idle term — driven by uTime alone, keeps particles alive at zero audio
    //   2. audio term — scales with uBass / uMid / uHighs for reactive beats
    //
    // The idle amplitude is kept subtle (0.08–0.15 units) so it reads as
    // gentle breathing, not jitter. The audio term can be much larger.
    // ─────────────────────────────────────────────────────────────────────────
    const MOTION_GLSL = {

        fluid: `
            // Idle: slow undulating drift that keeps every particle moving
            float idleAngle = sin(pos.x * 0.8 + uTime * 0.4) * cos(pos.y * 0.8 + uTime * 0.3) * 3.14159;
            pos.x += cos(idleAngle) * 0.12;
            pos.y += sin(idleAngle) * 0.12;
            pos.z += sin(uTime * 0.3 + pos.x * 0.5) * 0.08;
            // Audio: stronger reactive layer on top
            float audioAngle = sin(pos.x * 1.2 + uTime) * cos(pos.y * 1.2 + uTime * 0.7) * 3.14159;
            pos.x += cos(audioAngle) * uBass * 1.2;
            pos.y += sin(audioAngle) * uMid  * 1.2;
            pos.z += sin(uTime * 0.5 + pos.x) * uBass * 1.8;
        `,

        vortex: `
            // Idle: slow polar rotation so the whole cloud turns continuously
            float dist0  = length(pos.xy) + 0.001;
            float angle0 = atan(pos.y, pos.x) + uTime * 0.25;
            pos.x = cos(angle0) * dist0;
            pos.y = sin(angle0) * dist0;
            pos.z += sin(uTime * 0.35 + dist0) * 0.1;
            // Audio: tighten/loosen the spiral on beats
            float dist  = length(pos.xy) + 0.001;
            float angle = atan(pos.y, pos.x) + uTime * 0.8 + uBass * 2.0;
            float r     = dist * (1.0 - uBass * 0.25);
            pos.x = cos(angle) * r;
            pos.y = sin(angle) * r;
            pos.z += uMid * 2.5;
        `,

        orbital: `
            // Idle: each particle drifts along its tangent at a slow fixed speed
            float dist0  = length(pos.xy) + 0.001;
            float angle0 = atan(pos.y, pos.x) + uTime * 0.18;
            pos.x = cos(angle0) * dist0;
            pos.y = sin(angle0) * dist0;
            pos.z += sin(uTime * 0.4 + dist0 * 0.5) * 0.1;
            // Audio: radius expands with bass
            float dist  = length(pos.xy) + 0.001;
            float angle = atan(pos.y, pos.x) + uTime * 0.4;
            pos.x = cos(angle) * (dist + uBass * 0.6);
            pos.y = sin(angle) * (dist + uBass * 0.6);
            pos.z += sin(uTime + dist) * uMid * 1.2;
        `,

        chaotic: `
            // Idle: low-frequency wobble so particles drift even in silence
            pos.x += sin(uTime * 0.9 + pos.y * 0.6) * 0.10;
            pos.y += cos(uTime * 0.7 + pos.x * 0.6) * 0.10;
            pos.z += sin(uTime * 0.5 + pos.x * 0.4) * 0.08;
            // Audio: high-freq jitter — shape shakes apart on loud hits
            pos.x += sin(uTime * 60.0 + pos.y * 10.0) * uJitter * uMid  * 0.5;
            pos.y += cos(uTime * 60.0 + pos.x * 10.0) * uJitter * uMid  * 0.5;
            pos.z += sin(uTime * 30.0 + pos.x)         * uBass * 2.5;
        `,

        wave: `
            // Idle: gentle sine ripple that travels across the whole cloud
            pos.z += sin(uTime * 0.6 + pos.x * 0.7) * 0.14;
            pos.x += sin(uTime * 0.5 + pos.y * 0.5) * 0.09;
            pos.y += cos(uTime * 0.4 + pos.z * 0.5) * 0.09;
            // Audio: reactive ripple on top
            pos.z += uBass * 3.5;
            pos.x += sin(uTime * 2.0 + pos.y * 2.0) * uMid * 0.4 * uJitter;
            pos.y += cos(uTime * 2.0 + pos.x * 2.0) * uMid * 0.4 * uJitter;
        `,
    };

    const composition    = State.visual.composition;
    const selectedShape  = SHAPE_GLSL[composition]               || SHAPE_GLSL.spiral;
    const selectedMotion = MOTION_GLSL[State.visual.motionStyle] || MOTION_GLSL.wave;

    if (!SHAPE_GLSL[composition]) {
        console.warn(`[particles] Unknown composition "${composition}", falling back to spiral.`);
    }
    if (!MOTION_GLSL[State.visual.motionStyle]) {
        console.warn(`[particles] Unknown motionStyle "${State.visual.motionStyle}", falling back to wave.`);
    }

    // ── Effect code blocks ────────────────────────────────────────────────────
    const distortCode = VisualLanguage.hasEffect('distortion')
        ? `pos.x += sin(pos.y * 5.0 + uTime * 3.0) * uMid   * 0.25;
           pos.y += cos(pos.x * 5.0 + uTime * 2.0) * uHighs * 0.25;`
        : '';

    const pulseCode = VisualLanguage.hasEffect('pulse')
        ? `gl_PointSize *= (1.0 + uBass * 2.5);`
        : '';

    // Soft glow falloff vs hard disc. Both look good — glow is additive so
    // overlapping particles bloom brighter, which looks great with neon palette.
    const glowFragment = VisualLanguage.hasEffect('glow')
        ? `float alpha = max(0.0, 1.0 - dist * 1.8);`
        : `float alpha = step(0.5, 1.0 - dist);`;

    // ── Shader ────────────────────────────────────────────────────────────────
    const material = new THREE.ShaderMaterial({
        vertexShader: `
            uniform float uTime, uBass, uMid, uHighs, uSpread, uJitter;
            attribute float aT;
            varying vec3 vColor;

            void main() {
                vec3 pos = vec3(0.0);

                // ① Shape — rest position from aT
                { ${selectedShape} }

                // ② Spread — cloud breathes outward on beat (not particle size)
                pos *= 1.0 + uSpread * 1.5;

                // ③ Motion — idle + audio-reactive displacement
                { ${selectedMotion} }

                // ④ Effects — optional distortion warp
                ${distortCode}

                vColor = color;
                vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);

                // Particle size: base + pulse, hard-capped at 20% above base
                float baseSize = 7.0 / -mvPosition.z;
                gl_PointSize = baseSize * (1.0 + uBass * 0.2);

                // ⑤ Effects — extra pulse size with bass (opt-in)
                ${pulseCode}

                // Hard cap — never exceed 20% growth regardless of effects
                gl_PointSize = min(gl_PointSize, baseSize * 1.2);

                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragmentShader: `
            varying vec3 vColor;

            void main() {
                float dist = distance(gl_PointCoord, vec2(0.5));
                if (dist > 0.5) discard;
                ${glowFragment}
                gl_FragColor = vec4(vColor, alpha);
            }
        `,
        uniforms: {
            uTime:   { value: 0 },
            uBass:   { value: 0 },
            uMid:    { value: 0 },
            uHighs:  { value: 0 },
            uSpread: { value: State.params.particleDensity },
            uJitter: { value: State.ui.chaos }   // driven by Chaos slider
        },
        vertexColors: true,
        transparent: true,
        blending: VisualLanguage.hasEffect('glow') ? THREE.AdditiveBlending : THREE.NormalBlending
    });

    // Per-particle aT attribute
    const tValues = new Float32Array(TOTAL);
    for (let k = 0; k < TOTAL; k++) tValues[k] = k / TOTAL;
    geometry.setAttribute('aT', new THREE.BufferAttribute(tValues, 1));

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    // ── Resize ────────────────────────────────────────────────────────────────
    function onResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }
    window.addEventListener('resize', onResize);

    // ── Animate ───────────────────────────────────────────────────────────────
    function animate() {
        if (State.mode !== 'particles') return;
        requestAnimationFrame(animate);

        const rawAudio = VisualLanguage.getScaledAudio();

        // ── Slider → GPU uniform mapping (particles) ──────────────────────
        // responsivity: multiplies all audio bands before they hit the shader
        //   0 = visuals don't react to music at all
        //   2 = every beat is amplified 2x
        const r = State.ui.responsivity;
        const audio = {
            bass:  Math.min(1, rawAudio.bass  * r),
            mids:  Math.min(1, rawAudio.mids  * r),
            highs: Math.min(1, rawAudio.highs * r),
        };

        // energy: scales the uTime speed — faster clock = more active idle motion
        //   0 = particles barely drift   1 = full idle animation speed
        const time = performance.now() * 0.001 * (0.1 + State.ui.energy * 0.9);

        // chaos: directly drives uJitter — controls jitter amplitude in MOTION blocks
        //   0 = clean/smooth   2 = wildly scattered

        material.uniforms.uTime.value   = time;
        material.uniforms.uBass.value   = audio.bass;
        material.uniforms.uMid.value    = audio.mids;
        material.uniforms.uHighs.value  = audio.highs;
        material.uniforms.uSpread.value = State.ui.chaos * 0.3 + audio.bass * 0.6;
        material.uniforms.uJitter.value = State.ui.chaos;

        // Rotation axis depends on shape — 3D shapes rotate on Y, flat shapes on Z
        const is3D = ['sphere', 'torus', 'dna'].includes(composition);
        if (is3D) {
            points.rotation.y += 0.004 + audio.bass * 0.008;
            points.rotation.x += 0.001;
        } else if (['vortex', 'orbital'].includes(State.visual.motionStyle)) {
            points.rotation.z += 0.003 + audio.bass * 0.01;
        } else {
            points.rotation.z += 0.001;
        }

        renderer.render(scene, camera);
    }
    animate();

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return {
        destroy() {
            State.mode = '';
            window.removeEventListener('resize', onResize);
            renderer.dispose();
            geometry.dispose();
            material.dispose();
            if (renderer.domElement.parentNode) {
                renderer.domElement.parentNode.removeChild(renderer.domElement);
            }
        }
    };
}

// ─── Color helper ─────────────────────────────────────────────────────────────
function deriveThreeColor(baseColor, i, j) {
    switch (State.visual.colorStyle) {
        case 'monochrome': {
            const l = baseColor.r * 0.299 + baseColor.g * 0.587 + baseColor.b * 0.114;
            return new THREE.Color(l, l, l);
        }
        case 'pastel':
            return new THREE.Color(
                baseColor.r * 0.6 + 0.4,
                baseColor.g * 0.6 + 0.4,
                baseColor.b * 0.6 + 0.4
            );
        case 'iridescent': {
            const c = new THREE.Color();
            c.setHSL((i + j) / 256, 0.9, 0.65);
            return c;
        }
        case 'neon':
        default:
            return baseColor;
    }
}