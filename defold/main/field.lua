-- Field scenes (K1, K2, K3, K5, K7, K8, K9's meshes): one game object + model component per mesh,
-- spawned by factory. The prototype set decides the material: "" PBR, "_blend" sorted alpha,
-- "_inst" instanced, "_tex" textured (K3 respawns), "_pick" with a collision object (K8).
--
-- Fields past one collection's instance cap are split across collection proxies (main/split.lua).

local bridge = require "main.bridge"
local split = require "main.split"

local M = {}

local function constants(d)
    local out = {}
    for m, spec in ipairs(d.materials) do
        out[m] = {
            color = vmath.vector4(spec.color[1], spec.color[2], spec.color[3], spec.opacity),
            pbr = vmath.vector4(spec.roughness, spec.metalness, 0, 0),
        }
    end
    return out
end

local function factories(d, suffix)
    local out = {}
    for g, name in ipairs(d.geometries) do
        out[g] = msg.url("factories#" .. name .. suffix)
    end
    return out
end

--- Spawns meshes [from, to) and the groups they hang from, in the calling script's collection.
function M.chunk(d, from, to)
    local S = d.slots
    local hierarchy = d.groups > 0
    local groups, group_from = {}, 0
    if hierarchy then
        group_from = bench.get(S.parent, from)
        for k = group_from, bench.get(S.parent, to - 1) do
            groups[#groups + 1] = factory.create("factories#group", bench.vec3(S.groupPosition, k), bench.quat(S.groupQuat, k))
        end
    end

    local protos = factories(d, d.proto)
    local mats = constants(d)
    -- instanced materials take per-instance attributes; constants would split the batch
    local color_key = d.proto == "_inst" and "instance_color" or "base_color"
    local pbr_key = d.proto == "_inst" and "instance_pbr" or "pbr"

    local ids = {}
    local function spawn(j, list, texture)
        local id = factory.create(list[bench.get(S.geom, j) + 1], bench.vec3(S.position, j), bench.quat(S.quat, j), nil, bench.get(S.scale, j))
        if hierarchy then
            go.set_parent(id, groups[bench.get(S.parent, j) - group_from + 1])
        end
        local model = msg.url(nil, id, "model")
        local m = mats[bench.get(S.material, j) + 1]
        go.set(model, color_key, m.color)
        go.set(model, pbr_key, m.pbr)
        if texture then
            go.set(model, "texture0", texture)
        end
        ids[j - from + 1] = id
        return id
    end
    for j = from, to - 1 do
        spawn(j, protos)
    end

    local q = vmath.quat()
    local fill4, set_rotation = bench.fill4, go.set_rotation
    local quat_slot, group_slot = S.quat, S.groupQuat
    return {
        ids = ids,
        spawn = spawn,
        update = d.animated and function()
            for i = 1, #ids do
                fill4(quat_slot, from + i - 1, q)
                set_rotation(q, ids[i])
            end
            for k = 1, #groups do
                fill4(group_slot, group_from + k - 1, q)
                set_rotation(q, groups[k])
            end
        end or nil,
    }
end

local function churner(d, chunk, paths)
    local S = d.slots
    local tex_protos = factories(d, "_tex")
    -- one buffer per mip level; the harness writes the whole chain into the texture slot
    local levels, offset, size = {}, 0, d.churn.size
    while size >= 1 do
        levels[#levels + 1] = {
            offset = offset,
            buffer = buffer.create(size * size, { { name = hash("rgba"), type = buffer.VALUE_TYPE_UINT8, count = 4 } }),
            params = { type = graphics.TEXTURE_TYPE_2D, format = graphics.TEXTURE_FORMAT_RGBA, width = size, height = size, mipmap = #levels },
        }
        offset = offset + size * size * 4
        size = math.floor(size / 2)
    end
    -- WebGPU counts the base level in max_mipmaps, OpenGL does not
    local create = { type = graphics.TEXTURE_TYPE_2D, format = graphics.TEXTURE_FORMAT_RGBA, width = d.churn.size, height = d.churn.size, max_mipmaps = d.backend == "webgpu" and #levels or #levels - 1 }
    local textures, serial = {}, 0
    paths[#paths + 1] = "go.delete, then resource.create_texture (one per frame, every mip level uploaded with resource.set_texture) + factory.create with per-component constants and texture0; resource.release when the batch comes round"
    return function()
        local count = bench.get(S.churn, 0)
        if count == 0 then
            return
        end
        local batch = bench.get(S.churn, 1)
        serial = serial + 1
        local base = levels[1]
        bench.copy_to_buffer(S.texture, base.buffer, 0)
        local texture = resource.create_texture("/churn/" .. serial .. ".texturec", create, base.buffer)
        for l = 2, #levels do
            local level = levels[l]
            bench.copy_to_buffer(S.texture, level.buffer, level.offset)
            resource.set_texture(texture, level.params, level.buffer)
        end
        for k = 0, count - 1 do
            local j = bench.get(S.churnSlots, k)
            go.delete(chunk.ids[j + 1])
            chunk.spawn(j, tex_protos, texture)
        end
        if textures[batch] then
            resource.release(textures[batch])
        end
        textures[batch] = texture
    end
end

local function picker(chunk, paths)
    local slot_of = {}
    for i, id in ipairs(chunk.ids) do
        slot_of[id] = i - 1
    end
    local mask = { hash("pick") }
    bench.set_pick(function(self, x, y)
        local from, to = bridge.ray(x, y)
        local hit = physics.raycast(from, to, mask)
        return hit and slot_of[hit.id] or -1
    end)
    paths[#paths + 1] = "physics.raycast against a static collision object per mesh (3D physics): box and sphere shapes where exact, else the convex hull, which Bullet grows by its 0.04-unit margin"
end

--- K9: the HUD's tile source (one flipbook per atlas cell, generated with the harness's grid) gets the
--- atlas canvas's pixels; then the HUD's GUIs are spawned.
function M.hud(d)
    local a = d.hud.atlas
    local info = resource.get_atlas("/generated/hud/atlas.t.texturesetc")
    local pixels = buffer.create(a.width * a.height, { { name = hash("rgba"), type = buffer.VALUE_TYPE_UINT8, count = 4 } })
    bench.copy_to_buffer(d.slots.atlas, pixels, 0)
    resource.set_texture(info.texture, { type = graphics.TEXTURE_TYPE_2D, format = graphics.TEXTURE_FORMAT_RGBA, width = a.width, height = a.height }, pixels)
    BENCH_HUD, BENCH_HUD_GUIS = d.hud, 0
    BENCH_HUD.slots = d.slots
    factory.create("factories#hud")
end

--- Largest share of the field that fits `capacity` objects with its groups, in whole groups of 8.
local function share(d, capacity)
    if d.groups == 0 then
        return capacity
    end
    return math.floor(capacity * 8 / 9 / 8) * 8
end

function M.build(d)
    bridge.publish(d)
    local n = d.count
    local paths = { d.groups > 0 and "game object + model component per mesh (factory.create), parented to one game object per group" or "game object + model component per mesh (factory.create)" }
    if d.proto == "_inst" then
        paths[#paths + 1] = "instanced local-space material, colour and PBR as per-instance attributes"
    elseif d.proto == "_instc" then
        paths[#paths + 1] = "instanced local-space material, colour and PBR as per-component constants (instances with equal constants batch)"
    elseif d.proto == "_blend" then
        paths[#paths + 1] = "alpha-blended material drawn back to front (render.draw's default world sort)"
    end
    if d.animated then
        paths[#paths + 1] = "go.set_rotation per mesh from Lua"
    end

    local camera = d.cameraLive and d.slots.camera
    local function look()
        if camera then
            bridge.look(bench.vec3(camera, 0), bench.vec3(camera, 1))
        end
    end

    if n + d.groups <= split.MAIN_CAPACITY then
        local chunk = M.chunk(d, 0, n)
        local churn = d.churn and churner(d, chunk, paths)
        if d.pick then
            picker(chunk, paths)
        end
        if d.hud then
            M.hud(d)
            paths[#paths + 1] = d.hud.path
        end
        return {
            path = table.concat(paths, "; "),
            update = function()
                look()
                if churn then
                    churn()
                end
                if d.animated then
                    chunk.update()
                end
            end,
        }
    end

    assert(not (d.churn or d.pick or d.hud), "churn, picking and the HUD run in the main collection only")
    local worlds = split.load(d, "main.field", share(d, split.WORLD_CAPACITY))
    paths[#paths + 1] = worlds.path
    return { path = table.concat(paths, "; "), ready = worlds.ready, on_message = worlds.on_message, update = look }
end

return M
