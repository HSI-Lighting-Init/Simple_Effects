#version 300 es
// Ultra Key matte cleanup — Soften, horizontal pass.
// Writes the horizontal box sums for radius r and r+1. Each sum is 16-bit, so
// it is split across two RGBA8 channels: R/G = low/high of sum(r), B/A =
// low/high of sum(r+1). The vertical pass reconstructs and applies the
// reference's integer box formula.
precision highp float;
precision highp int;

uniform sampler2D u_inputImage;
uniform vec2 u_resolution;
uniform int u_r;

out vec4 fragColor;

float matteAt(ivec2 p) {
    p = clamp(p, ivec2(0), ivec2(u_resolution) - 1);
    return floor(texelFetch(u_inputImage, p, 0).a * 255.0 + 0.5);
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int sumR = 0;
    int sumR1 = 0;
    for (int i = -u_r - 1; i <= u_r + 1; i++) {
        int v = int(matteAt(p + ivec2(i, 0)));
        sumR1 += v;
        if (abs(i) <= u_r) sumR += v;
    }
    fragColor = vec4(
        float(sumR & 255) / 255.0,
        float((sumR >> 8) & 255) / 255.0,
        float(sumR1 & 255) / 255.0,
        float((sumR1 >> 8) & 255) / 255.0
    );
}
