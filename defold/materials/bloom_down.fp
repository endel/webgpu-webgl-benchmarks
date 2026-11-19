#version 140

// Bloom 2/4: halve resolution down the chain (4 bilinear taps = 16 texels).

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
    out_fragColor = vec4(0.25 * (texture(tex0, uv + vec2(-o.x, -o.y)).rgb + texture(tex0, uv + vec2(o.x, -o.y)).rgb + texture(tex0, uv + vec2(-o.x, o.y)).rgb + texture(tex0, uv + o).rgb), 1.0);
}
