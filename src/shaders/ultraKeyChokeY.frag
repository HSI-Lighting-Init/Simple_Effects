#version 300 es
// Ultra Key matte cleanup — Choke, vertical pass.
// R/G hold the horizontal mins for radius r / r+1. This pass takes the vertical
// mins, then applies the reference's integer fractional-radius lerp:
//   r == 0        -> (filter(1) * w + source * (256 - w)) >> 8
//   r  > 0        -> (filter(r) * w + filter(r+1) * (256 - w)) >> 8
precision highp float;
precision highp int;

uniform sampler2D u_inputImage;
uniform vec2 u_resolution;
uniform int u_r;
uniform int u_w;

out vec4 fragColor;

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float minR = 255.0;
    float minR1 = 255.0;
    for (int j = -u_r - 1; j <= u_r + 1; j++) {
        ivec2 q = clamp(p + ivec2(0, j), ivec2(0), ivec2(u_resolution) - 1);
        vec4 t = texelFetch(u_inputImage, q, 0);
        float vr = floor(t.r * 255.0 + 0.5);
        float v1 = floor(t.g * 255.0 + 0.5);
        minR1 = min(minR1, v1);
        if (abs(j) <= u_r) minR = min(minR, vr);
    }
    int a;
    if (u_r == 0) {
        a = (int(minR1) * u_w + int(minR) * (256 - u_w)) >> 8;
    } else {
        a = (int(minR) * u_w + int(minR1) * (256 - u_w)) >> 8;
    }
    fragColor = vec4(0.0, 0.0, 0.0, float(a) / 255.0);
}
