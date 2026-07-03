#version 300 es
// =============================================================================
//  GPU Overlay Effects — a single fragment shader implementing 10 real-time
//  procedural overlay effects, selected by `u_effect`.
// -----------------------------------------------------------------------------
//  Language: GLSL ES 3.00 (WebGL2). All helpers (hash / value noise / fBm /
//  rotation / blend modes) are defined once at the top. Every loop is bounded by
//  a compile-time constant so the compiler can unroll it.
//
//  To keep the host simple, the many per-effect parameters from the spec are
//  packed onto SEVEN generic keyframeable slots + two colours + a position +
//  blend mode. Each effect's comment block below states which slot maps to which
//  named parameter (with its default/range) and the algorithm used.
//
//    u_intensity  overall strength           u_tint    primary colour
//    u_scale      pattern zoom               u_tint2   secondary colour
//    u_speed      animation speed            u_pos     a 2D position (0..1)
//    u_detail     octaves/sharpness/density/complexity/frequency/pulse
//    u_softness   contrast/threshold/softness/width/radius/monochrome
//    u_extra      brightness/size/streak/strength/grain-size
//    u_opacity    final opacity              u_blend   0 Add 1 Screen 2 Overlay 3 Soft
//
//  When `u_adjustment == 1` the overlay effects emit their pattern as a
//  straight-alpha colour (no input image read) so the host can composite one
//  layer over an entire comp with the canvas blend mode. Displacement/darkening
//  effects (Heat Haze, Vignette) need the underlying pixels and emit nothing in
//  that mode.
// =============================================================================

precision highp float;
precision highp int;

in  vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_inputImage;
uniform vec2  u_resolution;
uniform float u_time;

uniform int   u_effect;       // 0..9 (see effect blocks below)
uniform float u_intensity;
uniform float u_scale;
uniform float u_speed;
uniform float u_detail;
uniform float u_softness;
uniform float u_extra;
uniform float u_opacity;
uniform vec3  u_tint;
uniform vec3  u_tint2;
uniform vec2  u_pos;
uniform int   u_blend;
uniform int   u_adjustment;

const int MAX_OCTAVES = 8;

// --- Hash / value noise / fBm -----------------------------------------------
float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic smootherstep
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p, int octaves, float lacunarity, float gain) {
    float value = 0.0, amp = 0.5, freq = 1.0;
    for (int i = 0; i < MAX_OCTAVES; i++) {
        if (i >= octaves) break;
        value += amp * noise(p * freq);
        freq *= lacunarity;
        amp *= gain;
    }
    return value;
}

// 2D rotation matrix.
mat2 rot(float a) {
    float s = sin(a), c = cos(a);
    return mat2(c, -s, s, c);
}

float aspect() { return u_resolution.x / max(u_resolution.y, 1.0); }

// --- Blend helpers (component-wise, RGB in 0..1) ----------------------------
vec3 bScreen(vec3 b, vec3 s)    { return 1.0 - (1.0 - b) * (1.0 - s); }
vec3 bOverlay(vec3 b, vec3 s)   { return mix(b * 2.0 * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b)); }
vec3 bSoftLight(vec3 b, vec3 s) { return mix(b * s * 2.0, 1.0 - (1.0 - b) * (1.0 - s) * 2.0, step(0.5, s)); }

// Composite an overlay colour `ov` over `base` by the selected blend mode.
vec3 composite(vec3 base, vec3 ov) {
    if (u_blend == 0) return base + ov;                       // Add
    if (u_blend == 1) return bScreen(base, ov);               // Screen
    if (u_blend == 2) return mix(base, bOverlay(base, ov), u_intensity);
    return mix(base, bSoftLight(base, ov), u_intensity);      // Soft Light
}

void main() {
    vec2 uv = v_texCoord;
    float t = u_time;

    // Effects fall into two families: OVERLAY effects fill (col, mask) and are
    // composited/emitted below; DIRECT effects (heat haze, vignette, grain) need
    // the source image and write `direct` themselves.
    vec3  col = vec3(0.0);   // overlay base colour
    float mask = 0.0;        // overlay strength 0..1
    vec3  direct = vec3(0.0);
    bool  isDirect = false;

    // ===== 0. Moving Shiny Clouds ==========================================
    //  detail=octaves(1-8), softness=contrast(1-4), extra=brightness(-0.5..0.5)
    if (u_effect == 0) {
        vec2 p = uv; p.x *= aspect(); p *= u_scale;
        p += vec2(t * u_speed * 0.3, t * u_speed * 0.2);
        p = rot(t * u_speed * 0.1) * p;
        float f = fbm(p, int(clamp(u_detail, 1.0, 8.0)), 2.0, 0.5);
        f = clamp((f - 0.5) * u_softness + 0.5 + u_extra, 0.0, 1.0);
        col = u_tint; mask = f;
    }
    // ===== 1. Underwater Caustics ==========================================
    //  detail=sharpness(1-10). Two rotated layered sine grids, sharpened.
    else if (u_effect == 1) {
        vec2 p = uv * u_scale; p.x *= aspect();
        float ts = t * u_speed;
        float c = 0.5 + 0.5 * sin(p.x * 10.0 + ts * 2.0) * sin(p.y * 13.0 - ts * 1.7);
        vec2 q = rot(1.0) * p;
        c += 0.5 + 0.5 * sin(q.x * 11.0 - ts * 1.3) * sin(q.y * 9.0 + ts * 2.1);
        c = pow(clamp(c * 0.5, 0.0, 1.0), max(1.0, u_detail));
        col = u_tint; mask = c;
    }
    // ===== 2. Lens Flare / Anamorphic Streak ===============================
    //  pos=source(0..1), extra=size(0.1-1), softness=streakLength(0-1).
    else if (u_effect == 2) {
        vec2 center = u_pos + vec2(sin(t * u_speed) * 0.3, 0.0);
        vec2 d = uv - center; d.x *= aspect();
        float sz = max(u_extra, 0.02);
        float glow = exp(-dot(d, d) / (sz * sz));
        // Anamorphic horizontal streak through the source.
        float dy = uv.y - center.y;
        float streak = exp(-dy * dy * 800.0)
                     * smoothstep(0.0, 0.2, 1.0 - abs(uv.x - center.x)) * u_softness;
        // A few ghost reflections mirrored across the frame centre.
        float ghosts = 0.0;
        for (int i = 1; i <= 4; i++) {
            vec2 gp = mix(center, vec2(1.0) - center, float(i) * 0.28);
            vec2 gd = uv - gp; gd.x *= aspect();
            ghosts += exp(-dot(gd, gd) / (sz * sz * 0.25)) * 0.35;
        }
        col = u_tint; mask = clamp(glow + streak + ghosts, 0.0, 1.0);
    }
    // ===== 3. Sparkle / Glitter ============================================
    //  detail=density(grid), extra=size(cell radius), speed=twinkle.
    else if (u_effect == 3) {
        float density = max(1.0, u_detail);
        vec2 g = uv * density; g.x *= aspect();
        vec2 cell = floor(g);
        vec2 f = fract(g);
        vec2 pt = vec2(hash(cell + 0.13), hash(cell + 0.71));
        float dd = distance(f, pt);
        float tw = max(0.0, sin(t * u_speed * 5.0 + hash(cell) * 10.0));
        float spark = (1.0 - smoothstep(0.0, max(u_extra, 0.001), dd)) * tw;
        col = u_tint; mask = clamp(spark, 0.0, 1.0);
    }
    // ===== 4. Heat Haze (displacement) — DIRECT ============================
    //  scale=1-20, extra=strength(0-0.1), detail=octaves(1-5).
    else if (u_effect == 4) {
        if (u_adjustment == 1) { fragColor = vec4(0.0); return; } // needs the image
        vec2 p = uv * u_scale;
        float ts = t * u_speed;
        int oct = int(clamp(u_detail, 1.0, 5.0));
        vec2 off = vec2(fbm(p + vec2(0.0, ts), oct, 2.0, 0.5),
                        fbm(p + vec2(5.2, 1.3 + ts), oct, 2.0, 0.5));
        off = (off - 0.5) * 2.0 * u_extra;
        vec3 o = texture(u_inputImage, uv).rgb;
        vec3 disp = texture(u_inputImage, clamp(uv + off, 0.0, 1.0)).rgb;
        direct = mix(o, disp, u_opacity);
        isDirect = true;
    }
    // ===== 5. Film Grain / Dust — DIRECT ===================================
    //  extra=grainSize(1-10), softness=monochrome(0-1), speed=re-randomise.
    else if (u_effect == 5) {
        vec2 gp = floor(uv * u_resolution / max(u_extra, 1.0));
        float tf = floor(t * u_speed * 60.0);
        float g = hash(gp + tf * 1.7);
        vec3 grain = mix(vec3(hash(gp + tf * 1.7 + 1.3),
                              hash(gp + tf * 1.7 + 2.7),
                              hash(gp + tf * 1.7 + 5.1)),
                         vec3(g), clamp(u_softness, 0.0, 1.0));
        vec3 o = texture(u_inputImage, uv).rgb;
        vec3 add = (grain - 0.5) * u_intensity;
        direct = mix(o, clamp(o + add, 0.0, 1.0), u_opacity);
        isDirect = true;
    }
    // ===== 6. Vignette Pulsation — DIRECT ==================================
    //  softness=radius(0.5-1.5), extra=edgeSoftness(0.1-1), detail=pulse(0-0.3).
    else if (u_effect == 6) {
        if (u_adjustment == 1) { fragColor = vec4(0.0); return; } // needs the image
        float dist = length(uv - 0.5) * 2.0;
        float r = u_softness + sin(t * u_speed) * u_detail;
        float factor = smoothstep(r - max(u_extra, 0.001), r, dist); // 0 centre → 1 edge
        vec3 o = texture(u_inputImage, uv).rgb;
        vec3 v = o * (1.0 - factor) + u_tint * factor;
        direct = mix(o, v, u_intensity * u_opacity);
        isDirect = true;
    }
    // ===== 7. Shimmer / Iridescence ========================================
    //  detail=frequency(1-10), tint/tint2=spectral endpoints.
    else if (u_effect == 7) {
        float lum = (u_adjustment == 1) ? 0.0 : dot(texture(u_inputImage, uv).rgb, vec3(0.299, 0.587, 0.114));
        float angle = lum * u_detail + dot(uv - 0.5, vec2(0.3, 0.7)) + t * u_speed;
        float m = 0.5 + 0.5 * sin(angle * 6.2831853);
        col = mix(u_tint, u_tint2, m); mask = 1.0;
    }
    // ===== 8. Aurora / Northern Lights =====================================
    //  extra=width(0.1-1), detail=complexity(1-5), tint=top / tint2=bottom.
    else if (u_effect == 8) {
        float ts = t * u_speed;
        float x = uv.x * u_scale + sin(uv.y * 4.0 + ts) * 0.5;
        float center = 0.5 + sin(x * 3.0 + ts * 0.7) * 0.4;
        center += (fbm(vec2(x, ts * 0.2), int(clamp(u_detail, 1.0, 5.0)), 2.0, 0.5) - 0.5) * 0.3;
        float band = abs(uv.y - center);
        float b = 1.0 - smoothstep(0.0, max(u_extra, 0.01), band);
        col = mix(u_tint2, u_tint, uv.y); mask = clamp(b, 0.0, 1.0);
    }
    // ===== 9. Smoke / Fog ==================================================
    //  softness=density(0-1), detail=complexity(2-6).
    else {
        vec2 p = uv * u_scale + vec2(t * u_speed * 0.2, t * u_speed * 0.1);
        float f = fbm(p, int(clamp(u_detail, 2.0, 6.0)), 2.0, 0.6);
        float fog = smoothstep(u_softness, u_softness + 0.2, f);
        col = u_tint; mask = fog;
    }

    // --- Output ------------------------------------------------------------
    if (isDirect) { fragColor = vec4(clamp(direct, 0.0, 1.0), 1.0); return; }

    // Adjustment layer: emit the pattern as straight-alpha; host blends it over
    // the comp below with the canvas blend mode.
    if (u_adjustment == 1) {
        float a = clamp(mask * u_intensity, 0.0, 1.0) * u_opacity;
        fragColor = vec4(col, a);
        return;
    }

    // Per-image: composite the overlay over this layer's own pixels.
    vec3 original = texture(u_inputImage, uv).rgb;
    vec3 ov = col * mask * u_intensity;
    vec3 result = composite(original, ov);
    vec3 outc = mix(original, result, u_opacity);
    fragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}
