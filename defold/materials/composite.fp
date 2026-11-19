#version 140

// Bloom 4/4: scene + strength * bloom, then the ACES + sRGB the scene materials skip in HDR.

in mediump vec2 var_uv;
out vec4 out_fragColor;

uniform mediump sampler2D tex0; // HDR scene
uniform mediump sampler2D tex1; // bloom

uniform fs_uniforms
{
    highp vec4 bloom_texel;
    highp vec4 bloom;
};

#include "/materials/tonemap.glsl"

void main()
{
    vec2 uv = vec2(var_uv.x, mix(var_uv.y, 1.0 - var_uv.y, bloom_texel.z));
    vec3 c = texture(tex0, uv).rgb + bloom.y * texture(tex1, uv).rgb;
    out_fragColor = vec4(LinearToSRGB(ACESFilmic(c)), 1.0);
}
