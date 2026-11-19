#version 300 es
// Ultra Key final pass — output mode, matte cleanup and Contrast.
// Reads the key pass (RGB + initial matte) and, when cleanup ran, the last
// cleanup pass's alpha. Contrast is the reference's linear matte contrast about
// Mid Point; Composite/Color keep the keyed RGB, Alpha writes the matte opaque.
precision highp float;
precision highp int;

uniform sampler2D u_inputImage;
uniform sampler2D u_inputImage2;
uniform vec2 u_resolution;
uniform int u_cleanup;
uniform int u_output;
uniform float u_contrast;
uniform float u_midPoint;

out vec4 fragColor;

int contrastMatte(int a) {
    if (u_contrast <= 0.0) return a;
    float M = u_midPoint * 255.0;
    float v = trunc((float(a) - M) * (u_contrast * 1024.0 + 1024.0));
    int shifted = int(floor(v / 1024.0));
    int outv = shifted + int(trunc(M));
    return clamp(outv, 0, 255);
}

void main() {
    ivec2 p = clamp(ivec2(gl_FragCoord.xy), ivec2(0), ivec2(u_resolution) - 1);
    vec4 key = texelFetch(u_inputImage, p, 0);
    int a = int(floor(key.a * 255.0 + 0.5));
    if (u_cleanup == 1) {
        a = int(floor(texelFetch(u_inputImage2, p, 0).a * 255.0 + 0.5));
    }
    a = contrastMatte(a);
    if (u_output == 1) {
        float v = float(a) / 255.0;
        fragColor = vec4(v, v, v, 1.0);
    } else {
        fragColor = vec4(key.rgb, float(a) / 255.0);
    }
}
