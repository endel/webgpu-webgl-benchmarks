-- A collection holds at most collection.max_instances (32,765) game objects, so larger scenes are
-- split across collection proxies (/generated/worlds/*): world k loads, then its spawner
-- (main/world.script) runs module.chunk(d, from, to) for its share.

local M = {}

M.MAX_INSTANCES = 32765
-- the main collection's own objects: bench, factories, worlds and the HUD
M.MAIN_CAPACITY = M.MAX_INSTANCES - 4
-- a world's own objects: factories and spawner
M.WORLD_CAPACITY = M.MAX_INSTANCES - 2
local WORLDS = 10

--- Loads worlds for d.count items, `per` to a world; returns the scene hooks main.script polls.
function M.load(d, module, per)
    local count = math.ceil(d.count / per)
    assert(count <= WORLDS, d.count .. " items need " .. count .. " collections, more than the " .. WORLDS .. " proxies generated")
    BENCH_SCENE, BENCH_MODULE, BENCH_WORLDS_BUILT = d, module, 0
    local ranges = {}
    for k = 1, count do
        ranges[hash("world" .. k)] = { k = k, from = (k - 1) * per, to = math.min(d.count, k * per) }
        msg.post("worlds#world" .. k, "async_load")
    end
    return {
        path = string.format("split across %d collection proxies (collection.max_instances is 32,765)", count),
        ready = function()
            return BENCH_WORLDS_BUILT == count
        end,
        on_message = function(message_id, message, sender)
            if message_id ~= hash("proxy_loaded") then
                return
            end
            local r = ranges[sender.fragment]
            msg.post(sender, "init")
            msg.post(sender, "enable")
            msg.post("world" .. r.k .. ":/spawner#spawner", "build", { from = r.from, to = r.to })
        end,
    }
end

return M
