#version 140

in highp vec3 var_world_pos;
in mediump vec3 var_normal;
in mediump vec2 var_texcoord0;

out vec4 out_fragColor;

uniform mediump sampler2D tex0;

uniform fs_uniforms
{
    highp vec4 base_color; // linear rgb, opacity
    highp vec4 pbr;        // roughness, metalness
};

#include "/materials/pbr.glsl"

void main()
{
    vec4 texel = texture(tex0, var_texcoord0);
    vec3 albedo = base_color.rgb * SRGBToLinear(texel.rgb);
    vec3 radiance = pbr_radiance(albedo, pbr.x, pbr.y, normalize(var_normal), var_world_pos);
    out_fragColor = vec4(pbr_output(radiance), base_color.a * texel.a);
}
