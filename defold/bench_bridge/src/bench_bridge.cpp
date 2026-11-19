// Shared memory between the harness (JavaScript) and the bench scripts (Lua).
//
// The harness allocates every slot in the wasm heap (Module._malloc), fills it, and passes the
// addresses to Lua in the scene description; Lua binds them to small ids and reads them through
// this module. Live slots (rotations, camera, lights, HUD) are rewritten before every frame.
// A double block carries the scene time and the harness's command.

#define LIB_NAME "BenchBridge"
#define MODULE_NAME "bench"

#include <dmsdk/sdk.h>
#include <dmsdk/gamesys/script.h>
#include <stdint.h>
#include <string.h>

#if defined(DM_PLATFORM_HTML5)
#include <emscripten.h>
#endif

namespace {

const int MAX_SLOTS = 64;
uint8_t* g_slot[MAX_SLOTS];
int g_bytes[MAX_SLOTS];

// [0] scene time t, [1] dt, [2] command from the harness, [3] its argument
double g_control[4];

dmScript::LuaCallbackInfo* g_pick = 0;

uint8_t* At(lua_State* L, int stride)
{
    int s = luaL_checkinteger(L, 1);
    int i = luaL_checkinteger(L, 2);
    if (s < 0 || s >= MAX_SLOTS || !g_slot[s] || i < 0 || (i + 1) * stride > g_bytes[s])
        luaL_error(L, "bench: element %d of slot %d is out of range", i, s);
    return g_slot[s] + i * stride;
}

int Bind(lua_State* L)
{
    int s = luaL_checkinteger(L, 1);
    double ptr = luaL_checknumber(L, 2);
    int bytes = luaL_checkinteger(L, 3);
    if (s < 0 || s >= MAX_SLOTS || bytes < 0)
        return luaL_error(L, "bench: bad slot %d", s);
    g_slot[s] = (uint8_t*)(uintptr_t)ptr;
    g_bytes[s] = bytes;
    return 0;
}

int Get(lua_State* L)
{
    lua_pushnumber(L, *(float*)At(L, 4));
    return 1;
}

int Vec3(lua_State* L)
{
    const float* p = (const float*)At(L, 12);
    dmScript::PushVector3(L, dmVMath::Vector3(p[0], p[1], p[2]));
    return 1;
}

int Vec4(lua_State* L)
{
    const float* p = (const float*)At(L, 16);
    dmScript::PushVector4(L, dmVMath::Vector4(p[0], p[1], p[2], p[3]));
    return 1;
}

int Quat(lua_State* L)
{
    const float* p = (const float*)At(L, 16);
    dmScript::PushQuat(L, dmVMath::Quat(p[0], p[1], p[2], p[3]));
    return 1;
}

/** Writes the slot's floats [i*4, i*4+4) into an existing vector4/quat, so per-frame reads allocate nothing. */
int Fill4(lua_State* L)
{
    const float* p = (const float*)At(L, 16);
    if (dmVMath::Quat* q = dmScript::ToQuat(L, 3))
        *q = dmVMath::Quat(p[0], p[1], p[2], p[3]);
    else
        *dmScript::CheckVector4(L, 3) = dmVMath::Vector4(p[0], p[1], p[2], p[3]);
    return 0;
}

/** The slot's bytes as a Lua string (gui.new_texture takes pixels as a string). */
int Bytes(lua_State* L)
{
    int s = luaL_checkinteger(L, 1);
    if (s < 0 || s >= MAX_SLOTS || !g_slot[s])
        return luaL_error(L, "bench: slot %d not bound", s);
    lua_pushlstring(L, (const char*)g_slot[s], g_bytes[s]);
    return 1;
}

/** Fills a Lua-created buffer from the slot's bytes at `offset` (resource.set_texture takes pixels as a buffer). */
int CopyToBuffer(lua_State* L)
{
    int s = luaL_checkinteger(L, 1);
    if (s < 0 || s >= MAX_SLOTS || !g_slot[s])
        return luaL_error(L, "bench: slot %d not bound", s);
    dmBuffer::HBuffer buffer = dmScript::CheckBufferUnpack(L, 2);
    int offset = luaL_optinteger(L, 3, 0);
    uint8_t* data = 0;
    uint32_t size = 0;
    if (dmBuffer::GetBytes(buffer, (void**)&data, &size) != dmBuffer::RESULT_OK || offset < 0 || offset + (int)size > g_bytes[s])
        return luaL_error(L, "bench: %d bytes at %d are outside slot %d (%d bytes)", (int)size, offset, s, g_bytes[s]);
    memcpy(data, g_slot[s] + offset, size);
    return 0;
}

int Time(lua_State* L)
{
    lua_pushnumber(L, g_control[0]);
    return 1;
}

int Command(lua_State* L)
{
    lua_pushinteger(L, (int)g_control[2]);
    lua_pushinteger(L, (int)g_control[3]);
    return 2;
}

/** Registers fn(self, x, y) -> slot index, called synchronously by the harness's pick(). */
int SetPick(lua_State* L)
{
    if (g_pick)
        dmScript::DestroyCallback(g_pick);
    g_pick = dmScript::CreateCallback(L, 1);
    return 0;
}

const luaL_reg Module_methods[] = {
    {"bind", Bind},
    {"get", Get},
    {"vec3", Vec3},
    {"vec4", Vec4},
    {"quat", Quat},
    {"fill4", Fill4},
    {"bytes", Bytes},
    {"copy_to_buffer", CopyToBuffer},
    {"time", Time},
    {"command", Command},
    {"set_pick", SetPick},
    {0, 0}
};

dmExtension::Result Initialize(dmExtension::Params* params)
{
    lua_State* L = params->m_L;
    luaL_register(L, MODULE_NAME, Module_methods);
    lua_pop(L, 1);
#if defined(DM_PLATFORM_HTML5)
    EM_ASM({ if (window.__defoldBench) window.__defoldBench.onControl($0); }, g_control);
#endif
    return dmExtension::RESULT_OK;
}

} // namespace

extern "C" {
#if defined(DM_PLATFORM_HTML5)
EMSCRIPTEN_KEEPALIVE
#endif
int bench_pick(float x, float y)
{
    if (!g_pick || !dmScript::IsCallbackValid(g_pick))
        return -2;
    lua_State* L = dmScript::GetCallbackLuaContext(g_pick);
    if (!dmScript::SetupCallback(g_pick))
        return -2;
    lua_pushnumber(L, x);
    lua_pushnumber(L, y);
    int id = -1;
    if (dmScript::PCall(L, 3, 1) == 0)
    {
        id = (int)lua_tointeger(L, -1);
        lua_pop(L, 1);
    }
    dmScript::TeardownCallback(g_pick);
    return id;
}
}

DM_DECLARE_EXTENSION(BenchBridge, LIB_NAME, 0, 0, Initialize, 0, 0, 0)
