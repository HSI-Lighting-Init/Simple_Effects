#version 300 es
// Fullscreen-quad vertex shader for the Shiny Clouds effect.
// Draw with a 2-triangle quad whose positions span [-1, 1] (clip space) and whose
// texcoords span [0, 1]. Pairs with shinyClouds.frag.

in  vec2 a_position;    // clip-space vertex, e.g. (-1,-1)…(1,1)
in  vec2 a_texCoord;    // 0..1 UV for the same vertex
out vec2 v_texCoord;    // handed to the fragment shader

void main() {
    v_texCoord  = a_texCoord;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
