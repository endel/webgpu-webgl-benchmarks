#version 140

// For meshes without normals (the Fox): glTF requires flat normals then, from the position derivatives.

in highp vec3 var_world_pos;
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
    vec3 N = normalize(cross(dFdx(var_world_pos), dFdy(var_world_pos)));
    vec4 texel = texture(tex0, var_texcoord0);
    vec3 albedo = base_color.rgb * SRGBToLinear(texel.rgb);
    out_fragColor = vec4(pbr_output(pbr_radiance(albedo, pbr.x, pbr.y, N, var_world_pos)), base_color.a * texel.a);
}
