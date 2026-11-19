-- K4: Sponza, one model component per glTF material (scripts/build-defold.ts splits the glTF), so
-- each takes its own constants and textures. The harness uploads the textures before the build
-- (main.script's command 2), as Defold archives would otherwise ship them uncompressed.

local bridge = require "main.bridge"

local M = {}

M.texture_path = function(i)
    return "/sponza/img" .. i .. ".texturec"
end

--- Command 2: the texture slot holds image i's mip chain; create the texture and upload every level.
function M.upload(d, i)
    local image = d.images[i + 1]
    local S = d.slots
    local offset, w, h, level = 0, image.width, image.height, 0
    local path
    while true do
        local buf = buffer.create(w * h, { { name = hash("rgba"), type = buffer.VALUE_TYPE_UINT8, count = 4 } })
        bench.copy_to_buffer(S.upload, buf, offset)
        local params = { type = graphics.TEXTURE_TYPE_2D, format = graphics.TEXTURE_FORMAT_RGBA, width = w, height = h }
        if level == 0 then
            -- WebGPU counts the base level in max_mipmaps, OpenGL does not
            params.max_mipmaps = d.backend == "webgpu" and image.levels or image.levels - 1
            path = resource.create_texture(M.texture_path(i), params, buf)
        else
            params.mipmap = level
            resource.set_texture(path, params, buf)
        end
        offset = offset + w * h * 4
        level = level + 1
        if level == image.levels then
            break
        end
        w, h = math.max(1, math.floor(w / 2)), math.max(1, math.floor(h / 2))
    end
end

function M.build(d)
    local B = bridge.publish(d)
    local S = d.slots
    local paths = { "Sponza as a model component per glTF material (factory.create), textures decoded in the page and uploaded with resource.create_texture" }
    if d.shadow then
        B.shadow = { max_distance = d.shadow.maxDistance, bias = 0.0007, normal_offset = 0.02 }
        paths[#paths + 1] = "hand-written 4-cascade sun shadows (render script: one 4096 depth atlas, override material; 3x3 PCF)"
    end
    local points
    if d.points then
        local pos, color = {}, {}
        for i = 1, 32 do
            pos[i], color[i] = vmath.vector4(), vmath.vector4()
        end
        for i, c in ipairs(d.points.color) do
            color[i] = vmath.vector4(c[1], c[2], c[3], 0)
        end
        points = { pos = pos, color = color, info = vmath.vector4(d.points.count, d.points.range, 0, 0) }
        B.points = points
        paths[#paths + 1] = string.format("hand-written forward loop over %d point lights in the material", d.points.count)
    end
    if d.bloom then
        B.bloom = d.bloom
        factory.create("factories#post")
        paths[#paths + 1] = "hand-written bloom (HDR RGBA16F target without MSAA, as Defold render targets have none; 5-level down/up chain, tone-mapping composite)"
    end
    local sponza = factory.create("factories#sponza")
    for k, m in ipairs(d.materials) do
        local url = msg.url(nil, sponza, "m" .. (k - 1))
        go.set(url, "base_color", vmath.vector4(m.color[1], m.color[2], m.color[3], m.color[4]))
        go.set(url, "pbr", vmath.vector4(m.roughness, m.metalness, m.cutoff, 0))
        for unit, image in pairs({ [0] = m.base, [1] = m.normal, [2] = m.mr }) do
            if image >= 0 then
                go.set(url, "texture" .. unit, hash(M.texture_path(image)))
            end
        end
    end
    return {
        path = table.concat(paths, "; "),
        update = function()
            bridge.look(bench.vec3(S.camera, 0), bench.vec3(S.camera, 1))
            if points then
                for i = 1, d.points.count do
                    bench.fill4(S.pointPos, i - 1, points.pos[i])
                end
            end
        end,
    }
end

return M
