#version 300 es
// =============================================================================
//  Shiny Clouds — animated caustic / light-leak effect
// -----------------------------------------------------------------------------
//  A moving, organic, cloud-like luminosity pattern (fractal Brownian motion of
//  value noise) drifts and morphs across an input image, so it looks like soft
//  refracted light is sliding over the surface. Fully procedural — no textures
//  other than the image being lit.
//
//  Language: GLSL ES 3.00 (WebGL2 / OpenGL ES 3.0).
//  For WebGL1 / GLSL ES 1.00, see the notes at the bottom of this file
//  (swap `texture`→`texture2D`, `fragColor`→`gl_FragColor`, drop `#version`,
//  and turn the `in`/`out` qualifiers back into `varying`).
// =============================================================================

precision highp float;
precision highp int;

// ---- Inputs -----------------------------------------------------------------
in  vec2 v_texCoord;    // 0..1 texture coordinate from the vertex stage
out vec4 fragColor;     // final composited pixel

// ---- Textures & frame state -------------------------------------------------
uniform sampler2D u_inputImage;   // the image being lit
uniform vec2      u_resolution;   // render target size in pixels (aspect fix)
uniform float     u_time;         // seconds since start — drives the animation

// ---- Adjustable parameters (sliders) ---------------------------------------
uniform float u_intensity;    // 0..2   (default 1.0)  brightness of the shine
uniform float u_scale;        // 0.5..5 (default 1.0)  cloud zoom factor
uniform float u_speed;        // 0..3   (default 0.5)  drift / morph speed
uniform float u_complexity;   // 1..8   (default 5)    fBm octaves (detail)
uniform float u_contrast;     // 1..4   (default 2.0)  sharpen the clouds
uniform float u_brightness;   // -0.5..0.5 (default 0) mid-grey shift of noise
uniform vec3  u_tintColor;    // default vec3(1.0)     colour of the shine
uniform int   u_blendMode;    // 0 Add · 1 Screen · 2 Overlay · 3 Soft Light
uniform float u_opacity;      // 0..1   (default 0.6)  opacity of the shine layer
uniform int   u_adjustment;   // 1 = emit the pattern with alpha only (no input
                              // image); the host composites it over the layers
                              // below via the canvas blend mode. 0 = self-composite.

// Compile-time ceiling for the octave loop. GLSL ES loops want a constant bound
// so the compiler can unroll them; we cap the live count with `u_complexity`.
const int MAX_OCTAVES = 8;

// -----------------------------------------------------------------------------
//  1. Base noise
// -----------------------------------------------------------------------------

// Hash: maps a 2D coordinate to a pseudo-random scalar in [0, 1]. Self-contained
// (no texture lookups). The large irrational-ish constants scramble the bits so
// neighbouring integer cells get uncorrelated values.
float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

// Value noise: hash the four corners of the cell `p` falls in, then interpolate
// with a QUINTIC curve  6t^5 - 15t^4 + 10t^3  (Perlin's "smootherstep"). Quintic
// has zero first AND second derivatives at the cell edges, which removes the
// directional grid creasing that a plain cubic smoothstep still leaves behind.
float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);

    float a = hash(i);                        // bottom-left
    float b = hash(i + vec2(1.0, 0.0));       // bottom-right
    float c = hash(i + vec2(0.0, 1.0));       // top-left
    float d = hash(i + vec2(1.0, 1.0));       // top-right

    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

    // Bilinear blend of the corners using the eased weights.
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// -----------------------------------------------------------------------------
//  2. fBm — sum octaves of noise at rising frequency, falling amplitude
// -----------------------------------------------------------------------------
//  `lacunarity` grows the frequency each octave (finer wisps); `gain` shrinks the
//  amplitude (finer wisps contribute less). Result sits roughly in [0, 1].
float fbm(vec2 p, int octaves, float lacunarity, float gain) {
    float value     = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;

    for (int i = 0; i < MAX_OCTAVES; i++) {
        if (i >= octaves) break;              // honour the live `Complexity`
        value     += amplitude * noise(p * frequency);
        frequency *= lacunarity;
        amplitude *= gain;
    }
    return value;
}

// -----------------------------------------------------------------------------
//  Blend helpers — all operate component-wise on linear-ish RGB in [0,1].
// -----------------------------------------------------------------------------
vec3 blendScreen(vec3 base, vec3 shine) {
    return 1.0 - (1.0 - base) * (1.0 - shine);
}

vec3 blendOverlay(vec3 base, vec3 shine) {
    // Where the BASE is dark → multiply; where it's light → screen.
    return mix(base * 2.0 * shine,
               1.0 - 2.0 * (1.0 - base) * (1.0 - shine),
               step(0.5, base));
}

vec3 blendSoftLight(vec3 base, vec3 shine) {
    // Where the SHINE is dark → darken; where it's light → lighten. Gentler than
    // Overlay because the switch is driven by the shine, not the base.
    return mix(base * shine * 2.0,
               1.0 - (1.0 - base) * (1.0 - shine) * 2.0,
               step(0.5, shine));
}

// -----------------------------------------------------------------------------
//  Main
// -----------------------------------------------------------------------------
void main() {
    // --- 3. Animate the sampling domain --------------------------------------
    // Aspect-correct so the clouds stay round on non-square images, then zoom.
    vec2 uv = v_texCoord;
    uv.x *= u_resolution.x / max(u_resolution.y, 1.0);
    uv *= u_scale;

    // (a) Drift: a slow global translation so the whole field slides.
    vec2 offset = vec2(u_time * u_speed * 0.3, u_time * u_speed * 0.2);
    uv += offset;

    // (b) Evolution: rotate the domain by a time-dependent angle so the SHAPES
    //     themselves twist and re-form — this is what stops it reading as a
    //     static texture merely scrolling past.
    float angle = u_time * u_speed * 0.1;
    float s = sin(angle);
    float c = cos(angle);
    uv = vec2(uv.x * c - uv.y * s,
              uv.x * s + uv.y * c);

    // --- 4. Shape the noise into distinct shiny puffs ------------------------
    int octaves = int(clamp(u_complexity, 1.0, float(MAX_OCTAVES)));
    float shine = fbm(uv, octaves, 2.0, 0.5);            // lacunarity 2, gain 0.5

    // Push toward the extremes around mid-grey: `contrast` separates bright puffs
    // from dark gaps, `brightness` slides the whole field up/down first.
    shine = clamp((shine - 0.5) * u_contrast + 0.5 + u_brightness, 0.0, 1.0);

    // --- 5. Tint -------------------------------------------------------------
    vec3 shineColor = shine * u_tintColor;

    // Adjustment-layer path: emit the shine as a tinted, straight-alpha overlay
    // and let the host's canvas blend mode composite it over everything below.
    // (No input image is read, so one adjustment layer can light the whole comp.)
    if (u_adjustment == 1) {
        float a = clamp(shine * u_intensity, 0.0, 1.0) * u_opacity;
        fragColor = vec4(u_tintColor, a);
        return;
    }

    // --- 6. Composite over the original --------------------------------------
    vec3 original = texture(u_inputImage, v_texCoord).rgb;
    vec3 result;
    if (u_blendMode == 0) {
        // Add — `intensity` scales how much light is poured on.
        result = original + shineColor * u_intensity;
    } else if (u_blendMode == 1) {
        // Screen — brightens, never clips past white.
        result = blendScreen(original, shineColor * u_intensity);
    } else if (u_blendMode == 2) {
        // Overlay — `intensity` is the blend amount toward the overlaid result.
        result = mix(original, blendOverlay(original, shineColor), u_intensity);
    } else {
        // Soft Light — subtle contrast-aware lighting.
        result = mix(original, blendSoftLight(original, shineColor), u_intensity);
    }

    // Final layer opacity: cross-fade the whole effect back toward the original.
    vec3 outRgb = mix(original, result, u_opacity);

    fragColor = vec4(clamp(outRgb, 0.0, 1.0), 1.0);      // output fully opaque
}
