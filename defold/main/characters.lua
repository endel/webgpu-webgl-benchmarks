-- K6: a game object + skinned model component per Fox, spawned by factory, each playing its clip
-- from its own phase with model.play_anim. Defold advances the animation with the engine's fixed dt.

local bridge = require "main.bridge"
local split = require "main.split"
local clips = require "generated.fox_clips"

local M = {}

function M.chunk(d, from, to)
    local S = d.slots
    local proto = msg.url("factories#fox" .. d.proto)
    local clip = clips[d.clip + 1]
    local ids = {}
    for j = from, to - 1 do
        local id = factory.create(proto, bench.vec3(S.position, j), vmath.quat_rotation_y(bench.get(S.yaw, j)), nil, d.scale)
        local phase = bench.get(S.phase, j) % clip.duration
        model.play_anim(msg.url(nil, id, "model"), clip.name, go.PLAYBACK_LOOP_FORWARD, { offset = phase / clip.duration })
        ids[#ids + 1] = id
    end
    -- only the root moves with the engine's animation update; nothing to do per frame from Lua
    return { ids = ids }
end

function M.build(d)
    bridge.publish(d)
    local path = "game object + skinned model component per character (factory.create), model.play_anim from the character's phase; GPU skinning"
    if d.proto == "_inst" then
        path = path .. ", instanced local-space material"
    elseif d.proto == "_cpu" then
        path = "game object + skinned model component per character (factory.create), model.play_anim from the character's phase; CPU skinning (world-space material)"
    end
    if d.count <= split.MAIN_CAPACITY then
        M.chunk(d, 0, d.count)
        return { path = path, update = function() end }
    end
    local s = split.load(d, "main.characters", split.WORLD_CAPACITY)
    return { path = path .. "; " .. s.path, ready = s.ready, on_message = s.on_message, update = function() end }
end

return M
