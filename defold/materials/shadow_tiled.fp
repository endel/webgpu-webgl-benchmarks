#version 140

// Depth packed into RGBA8 (Defold 1.13.1's WebGPU backend cannot sample depth textures). Geometry past
// a cascade's edge lands in a neighbouring tile: its depth quarter names the cascade, so it is dropped.

out vec4 out_fragColor;

void main()
{
    if (int(gl_FragCoord.x / 2048.0) != int(gl_FragCoord.z * 4.0))
        discard;
    vec4 e = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * gl_FragCoord.z);
    out_fragColor = e - e.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
}
