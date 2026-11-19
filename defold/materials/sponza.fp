#version 140

// glTF metal/rough: base colour (sRGB), normal map, metallic (B) and roughness (G), alpha mask.
// K4's features are hand-written here and in the render script (Defold has none built in):
// 4-cascade sun shadows (one depth atlas, 3x3 PCF) and up to 32 forward point lights.

in highp vec3 var_world_pos;
in mediump vec3 var_normal;
in mediump vec4 var_tangent;
in mediump vec2 var_texcoord0;

out vec4 out_fragColor;

uniform mediump sampler2D tex0; // base colour
uniform mediump sampler2D tex1; // normal
uniform mediump sampler2D tex2; // metallic-roughness
uniform highp sampler2D shadow_map; // the cascades: a 2x2 depth atlas, or (WebGPU) a 4x1 strip of packed depth

uniform fs_uniforms
{
    highp vec4 base_color; // factor, linear
    highp vec4 pbr;        // roughness factor, metallic factor, alpha cutoff (0 = opaque)
};

uniform fs_shadow
{
    highp mat4 shadow_mtx0; // world -> cascade's atlas uv + depth
    highp mat4 shadow_mtx1;
    highp mat4 shadow_mtx2;
    highp mat4 shadow_mtx3;
    highp vec4 shadow_splits; // far view distance of each cascade
    highp vec4 shadow_info;   // 1 = 2x2 depth atlas, 2 = 4x1 strip, depth packed in RGBA8 (WebGPU); texel width, depth bias, normal offset
    highp vec4 cam_fwd;
};

uniform fs_points
{
    highp vec4 point_pos[32];
    highp vec4 point_color[32]; // linear rgb * intensity
    highp vec4 point_info;      // count, range
};

#include "/materials/pbr.glsl"

float shadow_depth(vec2 uv)
{
    // explicit LOD: WGSL allows implicit-derivative sampling only in uniform control flow
    vec4 t = textureLod(shadow_map, uv, 0.0);
    return shadow_info.x > 1.5 ? dot(t, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)) : t.r;
}

float sun_visibility(vec3 P, vec3 N)
{
    if (shadow_info.x < 0.5)
        return 1.0;
    float depth = dot(P - cam_pos.xyz, cam_fwd.xyz);
    if (depth > shadow_splits.w)
        return 1.0;
    mat4 m = depth < shadow_splits.x ? shadow_mtx0 : depth < shadow_splits.y ? shadow_mtx1 : depth < shadow_splits.z ? shadow_mtx2 : shadow_mtx3;
    vec4 s = m * vec4(P + N * shadow_info.w, 1.0);
    s.xyz /= s.w;
    // the strip is 4:1 and each cascade has a quarter of its depth range
    bool strip = shadow_info.x > 1.5;
    vec2 texel = strip ? vec2(shadow_info.y, shadow_info.y * 4.0) : vec2(shadow_info.y);
    float bias = strip ? shadow_info.z * 0.25 : shadow_info.z;
    float lit = 0.0;
    for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++)
            lit += step(s.z - bias, shadow_depth(s.xy + vec2(x, y) * texel));
    return lit / 9.0;
}

// three.js's punctual falloff: inverse square, windowed to the light's range
float falloff(float d, float range)
{
    float w = clamp(1.0 - pow(d / range, 4.0), 0.0, 1.0);
    return w * w / max(d * d, 0.01);
}

void main()
{
    // every texture is sampled before the alpha test's discard (uniform control flow for WGSL)
    vec4 base = texture(tex0, var_texcoord0);
    vec4 mr = texture(tex2, var_texcoord0);
    vec3 tn = texture(tex1, var_texcoord0).xyz * 2.0 - 1.0;
    if (pbr.z > 0.0 && base.a < pbr.z)
        discard;
    vec3 albedo = base_color.rgb * SRGBToLinear(base.rgb);
    float roughness = pbr.x * mr.g, metalness = pbr.y * mr.b;

    vec3 n = normalize(var_normal);
    vec3 t = normalize(var_tangent.xyz - n * dot(n, var_tangent.xyz));
    vec3 b = cross(n, t) * var_tangent.w;
    vec3 N = normalize(mat3(t, b, n) * tn);
    if (!gl_FrontFacing)
        N = -N;

    vec3 P = var_world_pos;
    vec3 V = normalize(cam_pos.xyz - P);
    vec3 color = sun_color.rgb * sun_visibility(P, n) * pbr_direct(albedo, roughness, metalness, N, V, -sun_dir.xyz);
    color += pbr_ambient(albedo, roughness, metalness, N, V);
    int lights = int(point_info.x);
    for (int i = 0; i < 32; i++)
    {
        if (i >= lights)
            break;
        vec3 l = point_pos[i].xyz - P;
        float d = length(l);
        if (d < point_info.y)
            color += point_color[i].rgb * falloff(d, point_info.y) * pbr_direct(albedo, roughness, metalness, N, V, l / d);
    }
    out_fragColor = vec4(pbr_final(color), 1.0);
}
