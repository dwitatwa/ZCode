/**
 * 直连移动远控监听地址解析的运行时验证:loopback 固定 127.0.0.1;
 * tailnet 在没有 Tailscale 接口时必须 fail-closed(抛错而非回退 0.0.0.0)。
 *
 * 运行:pnpm exec tsx packages/desktop/scripts/verify-mobile-direct-bind.mts
 */
import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { resolveMobileDirectBindAddress } from "../src/main/mobileDirectServer.ts";

const loop = resolveMobileDirectBindAddress("loopback");
assert.deepEqual(loop, { host: "127.0.0.1", reachableHost: "127.0.0.1" });
console.log("loopback:", JSON.stringify(loop));

const hasTailnet = Object.values(networkInterfaces())
  .flat()
  .some((addr) => {
    if (!addr || addr.family !== "IPv4" || addr.internal) return false;
    const [first, second] = addr.address.split(".").map(Number);
    return first === 100 && second !== undefined && second >= 64 && second <= 127;
  });

if (hasTailnet) {
  const tailnet = resolveMobileDirectBindAddress("tailnet");
  assert.notEqual(tailnet.host, "0.0.0.0", "tailnet 绝不能回退 0.0.0.0");
  assert.match(tailnet.host, /^100\./, "tailnet 应绑定 100.64.0.0/10 地址");
  console.log("tailnet:", JSON.stringify(tailnet));
} else {
  assert.throws(
    () => resolveMobileDirectBindAddress("tailnet"),
    /Tailscale/,
    "无 Tailscale 接口时应 fail-closed",
  );
  console.log("tailnet: fail-closed(本机无 Tailscale 接口),符合预期");
}

console.log("mobile-direct bind-address smoke: OK");
