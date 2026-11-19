#version 140

// Bloom 1/4: threshold the HDR scene into half resolution (4 bilinear taps).

in mediump vec2 var_uv;
out vec4 out_fragColor;

uniform mediump sampler2D tex0;

uniform fs_uniforms
{
    highp vec4 bloom_texel; // source texel size
    highp vec4 bloom;       // threshold, strength, radius, level weight
};

void main()
{
    vec2 uv = vec2(var_uv.x, mix(var_uv.y, 1.0 - var_uv.y, bloom_texel.z));
    vec2 o = bloom_texel.xy;
    vec3 c = 0.25 * (texture(tex0, uv + vec2(-o.x, -o.y)).rgb + texture(tex0, uv + vec2(o.x, -o.y)).rgb + texture(tex0, uv + vec2(-o.x, o.y)).rgb + texture(tex0, uv + o).rgb);
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    out_fragColor = vec4(c * smoothstep(bloom.x, bloom.x + 0.01, lum), 1.0);
}
