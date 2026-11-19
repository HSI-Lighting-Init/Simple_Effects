#version 300 es
// Ultra Key matte cleanup — Choke, horizontal pass.
// Reads the 8-bit matte from the source alpha and writes the horizontal min for
// radius r (R) and r+1 (G). The vertical pass finishes the square min and the
// fractional-radius lerp, matching the reference's minFilter + fracFilter.
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
    float minR = 255.0;
    float minR1 = 255.0;
    for (int i = -u_r - 1; i <= u_r + 1; i++) {
        float v = matteAt(p + ivec2(i, 0));
        minR1 = min(minR1, v);
        if (abs(i) <= u_r) minR = min(minR, v);
    }
    fragColor = vec4(minR / 255.0, minR1 / 255.0, 0.0, 0.0);
}
