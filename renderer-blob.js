/**
 * RENDERER: 3D Blob (Three.js icosahedron with simplex noise deformation)
 * ────────────────────────────────────────────────────────────────────────
 * Reads from: State.visual, State.params, State.ui, State.audioData
 * Entry point: initBlobRenderer()
 * Returns: { destroy() }
 *
 * WHAT GEMINI CONTROLS HERE:
 *   motionStyle    → deformation character (noise scale/speed/intensity per style)
 *   colorStyle     → material type (wireframe neon, normal-mapped, transparent mono)
 *   effects.distortion → adds a second high-freq simplex layer on top of the base deform
 *   effects.pulse      → scale amplitude doubles on bass hits
 *   rhythmResponse     → which frequency band drives the scale pulse
 */

function initBlobRenderer() {
    const container = document.getElementById('canvas-container');

    // ── Scene setup ──────────────────────────────────────────────────────────
    const scene    = new THREE.Scene();
    const camera   = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);
    camera.position.z = 3;

    // ── Geometry ──────────────────────────────────────────────────────────────
    // Subdivision 64 = enough vertices for smooth morphing without being too heavy
    const geometry = new THREE.IcosahedronGeometry(1, 64);

    // ── Material — colorStyle picks the visual treatment ─────────────────────
    const material = buildBlobMaterial();

    const blob = new THREE.Mesh(geometry, material);
    scene.add(blob);

    const simplex = new SimplexNoise();

    // ── Resize handler ────────────────────────────────────────────────────────
    function onResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }
    window.addEventListener('resize', onResize);

    // ── Animation loop ────────────────────────────────────────────────────────
    function animate() {
        if (State.mode !== 'blob') return;
        requestAnimationFrame(animate);

        const rawAudio = VisualLanguage.getScaledAudio();

        // ── Slider → blob parameter mapping ──────────────────────────────────
        // responsivity: scales how much audio deforms and pulses the blob
        //   0 = blob ignores music   2 = every hit massively deforms surface
        const r = State.ui.responsivity;
        const audio = {
            bass:  Math.min(1, rawAudio.bass  * r),
            mids:  Math.min(1, rawAudio.mids  * r),
            highs: Math.min(1, rawAudio.highs * r),
        };

        // energy: controls idle deformation speed and rotation rate
        //   0 = blob barely moves   1 = full idle spin and morphing
        const idleSpeed = 0.05 + State.ui.energy * 0.95;
        const time = performance.now() * 0.001 * idleSpeed;

        // chaos: scales the simplex noise frequency — higher = bumpier, more complex surface
        //   0 = smooth orb   2 = aggressively detailed, spiky surface
        const { noiseScale: baseNoiseScale, noiseSpeed, displaceMult } = getDeformParams();
        const noiseScale = baseNoiseScale * (0.4 + State.ui.chaos * 0.8);

        // Keep shader uTime in sync (used by iridescent hue rotation)
        material.uniforms.uTime.value = time;

        // ── Vertex deformation ────────────────────────────────────────────────
        const positions = geometry.attributes.position;
        const vertex    = new THREE.Vector3();

        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            vertex.normalize();

            let noise = simplex.noise3D(
                vertex.x * noiseScale + time * noiseSpeed,
                vertex.y * noiseScale + time * noiseSpeed,
                vertex.z * noiseScale + time * noiseSpeed
            );

            if (VisualLanguage.hasEffect('distortion')) {
                noise += simplex.noise3D(
                    vertex.x * (noiseScale * 4) + time,
                    vertex.y * (noiseScale * 4),
                    vertex.z * (noiseScale * 4)
                ) * 0.3;
            }

            const displacement = 1 + (noise * audio.mids * displaceMult);
            vertex.multiplyScalar(displacement);
            positions.setXYZ(i, vertex.x, vertex.y, vertex.z);
        }
        positions.needsUpdate = true;
        geometry.computeVertexNormals();

        // ── Rotation — energy drives base rotation speed ──────────────────────
        blob.rotation.y += (0.003 + State.ui.energy * 0.012) * (1 + audio.mids  * 0.5);
        blob.rotation.x += (0.001 + State.ui.energy * 0.005) * (State.visual.motionStyle === 'chaotic' ? 1 + audio.highs : 0.5);

        if (State.visual.motionStyle === 'vortex') {
            blob.rotation.z += (0.003 + State.ui.energy * 0.008) + audio.bass * 0.02;
        }

        // ── Scale pulse — responsivity drives how much beats affect size ──────
        const scaleBand = {
            'bass-heavy':    audio.bass,
            'high-reactive': audio.highs,
            'balanced':      (audio.bass + audio.mids) * 0.5
        }[State.visual.rhythmResponse] ?? audio.bass;

        const pulseAmp = VisualLanguage.hasEffect('pulse') ? 0.6 : 0.3;
        blob.scale.setScalar(1 + scaleBand * pulseAmp);

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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds a palette-driven ShaderMaterial for the blob.
 * All colorStyles use the Gemini palette — no more default pink/yellow/purple.
 *
 * Color is derived by blending palette[0→2] based on the surface normal
 * direction, so the blob looks shaded and alive rather than flat.
 *
 * colorStyle further modifies saturation/brightness:
 *   neon        → full saturation, high brightness, sharp edges
 *   iridescent  → hue rotates with normal.z + time (animated shimmer)
 *   pastel      → palette blended toward white (desaturated, soft)
 *   monochrome  → luminance only from palette[0], single-tone ghost
 */
function buildBlobMaterial() {
    const p0 = new THREE.Color(State.params.palette[0]);
    const p1 = new THREE.Color(State.params.palette[1] || State.params.palette[0]);
    const p2 = new THREE.Color(State.params.palette[2] || State.params.palette[0]);

    // colorStyle tweaks applied to the palette colors before sending to shader
    function stylize(c) {
        const h = {}, s = {}, l = {};
        c.getHSL(h); // THREE quirk: getHSL returns object but mutates passed obj
        const hsl = { h: 0, s: 0, l: 0 };
        c.getHSL(hsl);
        switch (State.visual.colorStyle) {
            case 'pastel':     return new THREE.Color().setHSL(hsl.h, hsl.s * 0.4, Math.min(0.92, hsl.l * 1.5));
            case 'monochrome': return new THREE.Color().setHSL(0, 0, hsl.l);
            default:           return c.clone(); // neon + iridescent: use raw palette
        }
    }

    const c0 = stylize(p0), c1 = stylize(p1), c2 = stylize(p2);

    const isIridescent = State.visual.colorStyle === 'iridescent';
    const opacity      = State.visual.colorStyle === 'monochrome' ? 0.55
                       : State.visual.colorStyle === 'pastel'     ? 0.75
                       : 1.0;

    return new THREE.ShaderMaterial({
        wireframe:   true,
        transparent: true,
        uniforms: {
            uColor0:  { value: c0 },
            uColor1:  { value: c1 },
            uColor2:  { value: c2 },
            uTime:    { value: 0 },
            uOpacity: { value: opacity },
            uIrid:    { value: isIridescent ? 1.0 : 0.0 }
        },
        vertexShader: `
            varying vec3 vNormal;
            varying vec3 vPos;
            void main() {
                vNormal = normalize(normalMatrix * normal);
                vPos    = position;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3  uColor0, uColor1, uColor2;
            uniform float uTime, uOpacity, uIrid;
            varying vec3  vNormal, vPos;

            vec3 hueShift(vec3 col, float shift) {
                // Simple hue rotation in RGB space via Rodrigues
                vec3 k = vec3(0.57735);
                float c = cos(shift);
                return col * c + cross(k, col) * sin(shift) + k * dot(k, col) * (1.0 - c);
            }

            void main() {
                // Blend palette across the surface using normal direction
                float t1 = clamp(dot(vNormal, vec3(1.0, 0.0, 0.0)) * 0.5 + 0.5, 0.0, 1.0);
                float t2 = clamp(dot(vNormal, vec3(0.0, 1.0, 0.0)) * 0.5 + 0.5, 0.0, 1.0);

                vec3 col = mix(uColor0, uColor1, t1);
                     col = mix(col,     uColor2, t2 * 0.6);

                // iridescent: hue slowly rotates with normal.z + time
                if (uIrid > 0.5) {
                    float shift = vNormal.z * 1.8 + uTime * 0.4;
                    col = hueShift(col, shift);
                }

                gl_FragColor = vec4(col, uOpacity);
            }
        `
    });
}

/**
 * Returns simplex noise sampling parameters based on motionStyle.
 *
 * noiseScale    — spatial frequency (higher = more surface detail)
 * noiseSpeed    — how fast the noise field evolves over time
 * displaceMult  — how far vertices move from their rest position
 */
function getDeformParams() {
    switch (State.visual.motionStyle) {
        case 'fluid':   return { noiseScale: 0.8,  noiseSpeed: 0.4, displaceMult: 1.2 };
        case 'chaotic': return { noiseScale: 2.5,  noiseSpeed: 1.8, displaceMult: 2.0 };
        case 'vortex':  return { noiseScale: 1.5,  noiseSpeed: 1.2, displaceMult: 1.8 };
        case 'orbital': return { noiseScale: 1.0,  noiseSpeed: 0.6, displaceMult: 1.4 };
        case 'wave':
        default:        return { noiseScale: 1.0,  noiseSpeed: 0.8, displaceMult: 1.5 };
    }
}