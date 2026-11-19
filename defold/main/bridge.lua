-- Helpers shared by the scene modules: harness signals, the scene description and the view.
-- Scene modules publish what the render script needs in the global BENCH (script.shared_state).

local M = {}

function M.signal(name, arg)
    html5.run("__defoldBench.signal(" .. json.encode({ name = name, arg = arg or "" }) .. ")")
end

--- Decodes the harness's scene description and binds its slots; d.slots maps names to slot ids.
function M.describe()
    local d = json.decode(html5.run("__defoldBench.describe()"))
    local ids = {}
    for name, s in pairs(d.slots) do
        bench.bind(s.id, s.ptr, s.bytes)
        ids[name] = s.id
    end
    d.slots = ids
    return d
end

local function v3(t)
    return vmath.vector3(t[1], t[2], t[3])
end
M.v3 = v3

--- Publishes clear colour, ambient, sun and camera for the render script.
function M.publish(d)
    local B = {
        width = d.width,
        height = d.height,
        clear = vmath.vector4(d.clear[1], d.clear[2], d.clear[3], 1),
        -- the HDR target bloom reads is tone-mapped afterwards, so it clears to linear radiance
        clear_linear = vmath.vector4(d.clearLinear[1], d.clearLinear[2], d.clearLinear[3], 1),
        ambient = vmath.vector4(d.ambient[1], d.ambient[2], d.ambient[3], 0),
        sun_dir = vmath.vector4(0, -1, 0, 0),
        sun_color = vmath.vector4(0),
        fov = math.rad(d.camera.fovY),
        near = d.camera.near,
        far = d.camera.far,
        blend = d.blend,
        backend = d.backend,
        hud = d.hud ~= nil and d.hud ~= json.null,
        version = 0,
    }
    if d.sun then
        B.sun_dir = vmath.vector4(d.sun.direction[1], d.sun.direction[2], d.sun.direction[3], 0)
        B.sun_color = vmath.vector4(d.sun.color[1], d.sun.color[2], d.sun.color[3], 0)
    end
    B.proj = vmath.matrix4_perspective(B.fov, d.width / d.height, B.near, B.far)
    BENCH = B
    M.look(v3(d.camera.position), v3(d.camera.target))
    return B
end

--- Points the camera; the render script picks it up through BENCH.version.
function M.look(eye, target)
    local B = BENCH
    B.eye = eye
    B.view = vmath.matrix4_look_at(eye, target, vmath.vector3(0, 1, 0))
    B.cam_pos = vmath.vector4(eye.x, eye.y, eye.z, 1)
    local f = vmath.normalize(target - eye)
    B.cam_fwd = vmath.vector4(f.x, f.y, f.z, 0)
    B.frustum = B.proj * B.view
    B.version = B.version + 1
end

--- World-space ray through a canvas pixel (origin top-left), from the near to the far plane.
function M.ray(x, y)
    local B = BENCH
    local inv = vmath.inv(B.proj * B.view)
    local nx, ny = 2 * x / B.width - 1, 1 - 2 * y / B.height
    local a = inv * vmath.vector4(nx, ny, -1, 1)
    local b = inv * vmath.vector4(nx, ny, 1, 1)
    return vmath.vector3(a.x / a.w, a.y / a.w, a.z / a.w), vmath.vector3(b.x / b.w, b.y / b.w, b.z / b.w)
end

return M
