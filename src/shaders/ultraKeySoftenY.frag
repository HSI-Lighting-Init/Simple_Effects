#version 300 es
// Ultra Key matte cleanup — Soften, vertical pass.
// Reconstructs the horizontal 16-bit sums, finishes the square box sums, applies
// out = (sum * floor(65536/n) + n/2) >> 16 for radius r and r+1, then the
// reference's integer fractional-radius lerp.
precision highp float;
precision highp int;

uniform sampler2D u_inputImage;
uniform vec2 u_resolution;
uniform int u_r;
uniform int u_w;

out vec4 fragColor;

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int sumR = 0;
    int sumR1 = 0;
    for (int j = -u_r - 1; j <= u_r + 1; j++) {
        ivec2 q = clamp(p + ivec2(0, j), ivec2(0), ivec2(u_resolution) - 1);
        vec4 t = texelFetch(u_inputImage, q, 0);
        int hr = int(floor(t.r * 255.0 + 0.5)) | (int(floor(t.g * 255.0 + 0.5)) << 8);
        int h1 = int(floor(t.b * 255.0 + 0.5)) | (int(floor(t.a * 255.0 + 0.5)) << 8);
        sumR1 += h1;
        if (abs(j) <= u_r) sumR += hr;
    }
    int n = (2 * u_r + 1) * (2 * u_r + 1);
    int n1 = (2 * u_r + 3) * (2 * u_r + 3);
    int vr = (sumR * (65536 / n) + (n >> 1)) >> 16;
    int v1 = (sumR1 * (65536 / n1) + (n1 >> 1)) >> 16;
    int a;
    if (u_r == 0) {
        a = (v1 * u_w + vr * (256 - u_w)) >> 8;
    } else {
        a = (vr * u_w + v1 * (256 - u_w)) >> 8;
    }
    fragColor = vec4(0.0, 0.0, 0.0, float(a) / 255.0);
}
