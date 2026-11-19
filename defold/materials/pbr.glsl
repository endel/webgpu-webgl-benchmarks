// Metal/rough GGX with a sun and a flat ambient, ACES-tone-mapped and sRGB-encoded in place,
// matching three.js's MeshStandardMaterial + ACESFilmicToneMapping. Spec light units are used
// 1:1 with a Lambert term that is not divided by pi (PlayCanvas's convention, LIGHT_SCALE = 1).

uniform fs_lights
{
    highp vec4 sun_dir;   // direction the light travels
    highp vec4 sun_color; // linear rgb * intensity
    highp vec4 ambient;   // linear rgb * intensity
    highp vec4 cam_pos;
};

#include "/materials/tonemap.glsl"

const float PI = 3.14159265;

float D_GGX(float a2, float NoH)
{
    float d = NoH * NoH * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}

float V_SmithGGXCorrelated(float a2, float NoL, float NoV)
{
    float gv = NoL * sqrt(a2 + (1.0 - a2) * NoV * NoV);
    float gl = NoV * sqrt(a2 + (1.0 - a2) * NoL * NoL);
    return 0.5 / max(gv + gl, 1e-6);
}

// Karis' analytic DFG fit, as three.js's DFGApprox
vec2 DFGApprox(float roughness, float NoV)
{
    const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
    const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
    vec4 r = roughness * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
    return vec2(-1.04, 1.04) * a004 + r.zw;
}

/** (diffuse + specular) * NoL for a light from direction L (towards the light), before its colour. */
vec3 pbr_direct(vec3 albedo, float roughness, float metalness, vec3 N, vec3 V, vec3 L)
{
    vec3 H = normalize(L + V);
    float NoL = max(dot(N, L), 0.0);
    float NoV = max(dot(N, V), 1e-4);
    float NoH = max(dot(N, H), 0.0);
    float VoH = max(dot(V, H), 0.0);
    roughness = max(roughness, 0.0525);
    float a2 = roughness * roughness * roughness * roughness;
    vec3 f0 = mix(vec3(0.04), albedo, metalness);
    vec3 F = f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0);
    vec3 specular = F * (D_GGX(a2, NoH) * V_SmithGGXCorrelated(a2, NoL, NoV)) * PI;
    return NoL * (albedo * (1.0 - metalness) + specular);
}

vec3 pbr_ambient(vec3 albedo, float roughness, float metalness, vec3 N, vec3 V)
{
    float NoV = max(dot(N, V), 1e-4);
    vec3 f0 = mix(vec3(0.04), albedo, metalness);
    vec2 dfg = DFGApprox(max(roughness, 0.0525), NoV);
    vec3 ambientSpecular = f0 * dfg.x + dfg.y;
    return ambient.rgb * (albedo * (1.0 - metalness) * (1.0 - ambientSpecular) + ambientSpecular);
}

/** Linear HDR radiance from the sun and the ambient. */
vec3 pbr_radiance(vec3 albedo, float roughness, float metalness, vec3 N, vec3 P)
{
    vec3 V = normalize(cam_pos.xyz - P);
    return sun_color.rgb * pbr_direct(albedo, roughness, metalness, N, V, -sun_dir.xyz) + pbr_ambient(albedo, roughness, metalness, N, V);
}

/** Display-ready colour: ACES tone mapping and sRGB encoding. */
vec3 pbr_output(vec3 radiance)
{
    return LinearToSRGB(ACESFilmic(radiance));
}

/** cam_pos.w = 1 while the scene renders to the HDR target that bloom reads; it tone-maps afterwards. */
vec3 pbr_final(vec3 radiance)
{
    return cam_pos.w > 0.5 ? radiance : pbr_output(radiance);
}
