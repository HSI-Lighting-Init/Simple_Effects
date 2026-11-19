#version 300 es
// Ultra Key — matches Premiere Pro 2023's Ultra Key output.
// The key pass: keyed RGB plus the 8-bit matte (quantized source-alpha product).
// The CPU precomputes the key and colour-correction uniforms
// (src/lib/ultraKey.ts); this pass is a line-by-line port of
// docs/ultra-key-reference.mjs. Alpha stays straight. Choke/Soften/Contrast and
// the output modes run in the cleanup and final passes.
precision highp float;
precision highp int;

uniform sampler2D u_inputImage;
uniform vec2 u_resolution;

uniform float u_ku, u_kv, u_kZ, u_invK;
uniform float u_gT, u_gR, u_gD, u_tol, u_spill2, u_luma2, u_hi2, u_sh2, u_ped;
uniform vec3 u_ccR, u_ccG, u_ccB, u_ccO;

out vec4 fragColor;

// Premiere runs with FTZ/DAZ on; use 1e-30 so GPUs that flush denormals behave.
const float FLT_MIN = 1e-30;

float eotf(float v) {
    return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
}

// sRGB OETF then trunc(255*e + 0.5) exactly as the reference's toSrgb8.
float oetf8(float l) {
    l = clamp(l, 0.0, 1.0);
    float e = l < 0.0031308 ? l * 12.92 : 1.055 * pow(l, 0.41666) - 0.055;
    return floor(255.0 * e + 0.5) / 255.0;
}

// Keying space: X,Y = opponent chroma (zero for grey), Z = Rec.709 luminance.
vec3 toKeySpace(vec3 c) {
    return vec3(
        0.471405 * c.r - 0.235702 * c.g - 0.235702 * c.b,
        0.408248 * c.g - 0.408248 * c.b,
        0.212671 * c.r + 0.71516 * c.g + 0.072169 * c.b
    );
}
vec3 fromKeySpace(vec3 xyz) {
    return vec3(
        1.670177 * xyz.x - 0.7875 * xyz.y + xyz.z,
        -0.451143 * xyz.x + 0.437245 * xyz.y + xyz.z,
        -0.451143 * xyz.x - 2.012245 * xyz.y + xyz.z
    );
}
vec3 colourCorrect(vec3 c) {
    return vec3(dot(c, u_ccR) + u_ccO.x, dot(c, u_ccG) + u_ccO.y, dot(c, u_ccB) + u_ccO.z);
}

void main() {
    ivec2 p = clamp(ivec2(gl_FragCoord.xy), ivec2(0), ivec2(u_resolution) - 1);
    vec4 src = texelFetch(u_inputImage, p, 0);
    vec3 lin = vec3(eotf(src.r), eotf(src.g), eotf(src.b));

    // Black key: Premiere keys nothing and skips the key maths (also avoids
    // GLSL's undefined 0/0). Apply colour correction only.
    if (u_kZ < 1e-6) {
        vec3 cc = colourCorrect(lin);
        fragColor = vec4(oetf8(cc.r), oetf8(cc.g), oetf8(cc.b), src.a);
        return;
    }

    vec3 xyz = toKeySpace(lin);
    float zz = max(xyz.z, FLT_MIN);
    float u = xyz.x / zz;
    float v = xyz.y / zz;
    float du = u - u_ku;
    float dv = v - u_kv;
    float dz = xyz.z - u_kZ;
    // The oracle keeps the keyed pixel's RGB (e.g. neutral grey at alpha 0) and
    // compares all four channels. In float32, a pixel equal to the key still
    // leaves ~1e-8 of luma error, which the 1/screen un-mix would amplify to
    // white. A 1e-6 linear-luma difference is invisible; snap it so the same
    // 174-grey result falls out.
    if (abs(dz) < 1e-6) dz = 0.0;
    float dist = sqrt(max(du * du + dv * dv, FLT_MIN));
    float cosT = (du * u_ku + dv * u_kv) / dist * u_invK;
    float D = dist * u_invK;

    float tA = cosT > 0.0 ? u_tol * cosT : 0.0;
    float tS = cosT > 0.0 ? u_tol : u_tol * (1.0 + cosT);

    float aC = min((1.0 - tA) * D * u_gT, 1.0);
    float lr = dz / u_kZ;
    float aL = min(lr * (lr <= 0.0 ? -u_sh2 : u_hi2), 1.0);
    float scr = aC + aL - aC * aL;                              // screen (pre-pedestal)
    float alpha = max(scr * (1.0 + u_ped) - u_ped, 0.0);

    float spillA = clamp((1.0 - tS) * D * u_gR, FLT_MIN, 1.0);
    float spillK = (1.0 / spillA - 1.0) * u_spill2;
    float desat = min((1.0 - tS) * D * u_gD, 1.0);
    float zO = max(xyz.z + dz * (1.0 / max(scr, FLT_MIN) - 1.0) * u_luma2, 0.0);
    vec3 outLinear = fromKeySpace(vec3(
        (u + spillK * du) * desat * zO,
        (v + spillK * dv) * desat * zO,
        zO
    ));
    vec3 outRgb = colourCorrect(outLinear);

    // The oracle truncates a * A where A is the source's 8-bit alpha, so round
    // the sampled alpha back to that byte first (src.a * 255.0 can land 1 low).
    float srcA = floor(src.a * 255.0 + 0.5);
    float outA = floor(clamp(alpha, 0.0, 1.0) * srcA) / 255.0;
    fragColor = vec4(oetf8(outRgb.r), oetf8(outRgb.g), oetf8(outRgb.b), outA);
}
