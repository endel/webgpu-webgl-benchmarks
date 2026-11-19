#version 140

in highp vec3 var_world_pos;
in mediump vec3 var_normal;

out vec4 out_fragColor;

uniform fs_uniforms
{
    highp vec4 base_color; // linear rgb, opacity
    highp vec4 pbr;        // roughness, metalness
};

#include "/materials/pbr.glsl"

void main()
{
    vec3 radiance = pbr_radiance(base_color.rgb, pbr.x, pbr.y, normalize(var_normal), var_world_pos);
    out_fragColor = vec4(pbr_output(radiance), base_color.a);
}
