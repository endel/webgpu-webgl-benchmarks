#version 140

// Bloom 3/4: tent-filter a level up and add it to the next larger one (additive blend), weighted
// like three.js's UnrealBloomPass factors mixed by radius.

in mediump vec2 var_uv;
out vec4 out_fragColor;

uniform mediump sampler2D tex0;

uniform fs_uniforms
{
    highp vec4 bloom_texel;
    highp vec4 bloom;
};

void main()
{
    vec2 uv = vec2(var_uv.x, mix(var_uv.y, 1.0 - var_uv.y, bloom_texel.z));
    vec2 o = bloom_texel.xy;
    vec3 c = 4.0 * texture(tex0, uv).rgb;
    c += 2.0 * (texture(tex0, uv + vec2(o.x, 0.0)).rgb + texture(tex0, uv - vec2(o.x, 0.0)).rgb + texture(tex0, uv + vec2(0.0, o.y)).rgb + texture(tex0, uv - vec2(0.0, o.y)).rgb);
    c += texture(tex0, uv + o).rgb + texture(tex0, uv - o).rgb + texture(tex0, uv + vec2(o.x, -o.y)).rgb + texture(tex0, uv + vec2(-o.x, o.y)).rgb;
    out_fragColor = vec4(c / 16.0 * bloom.w, 1.0);
}
