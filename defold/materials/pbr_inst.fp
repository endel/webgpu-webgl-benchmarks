#version 140

in highp vec3 var_world_pos;
in mediump vec3 var_normal;
in mediump vec4 var_color;
in mediump vec4 var_pbr;

out vec4 out_fragColor;

#include "/materials/pbr.glsl"

void main()
{
    vec3 radiance = pbr_radiance(var_color.rgb, var_pbr.x, var_pbr.y, normalize(var_normal), var_world_pos);
    out_fragColor = vec4(pbr_output(radiance), var_color.a);
}
