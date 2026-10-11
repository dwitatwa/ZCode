/**
 * 直连移动远控传输桥的运行时冒烟验证。
 *
 * 不依赖 Electron:用一个 in-process MessagePort 替身履行 Host 侧端口语义,
 * 把「手机 WS(SocketProtocol 13 字节帧头)」和「Host MessagePort(整包消息)」真实
 * 接进 attachMobileDirectClient 生产代码,证明双向转发、消息边界与 close 传播成立。
 *
 * 注意:bridge 自己终结了 WS 侧 SocketProtocol,所以测试必须以「裸远端」身份工作:
 *   - 手机 → Host:手工组 13 字节帧后用 socket.feed() 灌入;
 *   - Host → 手机:直接读 socket.sentToClient 里的帧再解帧。
 *
 * 运行:pnpm exec tsx packages/desktop/scripts/verify-mobile-direct-bridge.mts
 */
import assert from "node:assert/strict";
import {
  Emitter,
  MessagePortProtocol,
  VSBuffer,
  type ISocket,
  type MessagePortLike,
  type MessagePortPayload,
} from "@zcode/rpc";

const HEADER_SIZE = 13;
const REGULAR = 1;

// ---- 一个「假 Host」:接收 postMessage(含 AttachServicePort),用 MessagePortProtocol 终结 ----

interface FakePort {
  postMessage(data: MessagePortPayload): void;
  on(event: "message", listener: (e: { data: MessagePortPayload }) => void): void;
  off(event: "message", listener: (e: { data: MessagePortPayload }) => void): void;
  once(event: "close", listener: () => void): void;
  close(): void;
  start(): void;
}

/** 造一对互通的端口:任一端 postMessage 会到达对端 message 监听者。 */
function createPortPair(): { a: FakePort; b: FakePort } {
  const listenersA = new Set<(e: { data: MessagePortPayload }) => void>();
  const listenersB = new Set<(e: { data: MessagePortPayload }) => void>();
  const closeA: Array<() => void> = [];
  const closeB: Array<() => void> = [];

  const a: FakePort = {
    postMessage(data) {
      for (const l of listenersB) l({ data });
    },
    on(_t, l) {
      listenersA.add(l);
    },
    off(_t, l) {
      listenersA.delete(l);
    },
    once(_t, l) {
      closeA.push(l);
    },
    close() {
      for (const l of closeA) l();
    },
    start() {},
  };
  const b: FakePort = {
    postMessage() {
      throw new Error("test: Host 侧不应主动 postMessage 回端口");
    },
    on(_t, l) {
      listenersB.add(l);
    },
    off(_t, l) {
      listenersB.delete(l);
    },
    once(_t, l) {
      closeB.push(l);
    },
    close() {
      for (const l of closeB) l();
    },
    start() {},
  };
  // b.postMessage 数据本应写回 a;bridge 只用 portProtocol.send(port1) 与直接操作 port1。
  (b as { postMessage: (data: MessagePortPayload) => void }).postMessage = (data) => {
    for (const l of listenersA) l({ data });
  };
  return { a, b };
}

/** 由测试驱动字节流的假 WebSocket;sentToClient 收集 bridge 写回手机的帧。 */
function createFakeSocket(): ISocket & {
  feed(bytes: Uint8Array): void;
  sentToClient: Uint8Array[];
} {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  const sentToClient: Uint8Array[] = [];
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    sentToClient,
    feed(bytes) {
      onData.fire(VSBuffer.wrap(bytes));
    },
    write(buffer) {
      sentToClient.push(new Uint8Array(buffer.buffer));
    },
    end() {
      onEnd.fire();
      onClose.fire();
    },
    drain: () => Promise.resolve(),
    dispose() {
      onClose.fire();
      onEnd.fire();
    },
  };
}

function toLike(port: FakePort): MessagePortLike {
  return {
    addEventListener(_t, l) {
      port.on("message", l);
    },
    removeEventListener(_t, l) {
      port.off("message", l);
    },
    postMessage(data) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

/** 按 SocketProtocol 帧格式组一条 Regular 消息。 */
function frameMessage(body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_SIZE + body.length);
  frame[0] = REGULAR;
  new DataView(frame.buffer).setUint32(9, body.length, false);
  frame.set(body, HEADER_SIZE);
  return frame;
}

/** 从 bridge 写回手机的帧里解出 payload(单帧、Regular)。 */
function unframe(frame: Uint8Array): Uint8Array {
  assert.equal(frame[0], REGULAR, "写回帧类型应为 Regular");
  const length = new DataView(frame.buffer).getUint32(9, false);
  return frame.subarray(HEADER_SIZE, HEADER_SIZE + length);
}

async function main(): Promise<void> {
  const { attachMobileDirectClient } = await import("../src/main/mobileDirectBridge.ts");

  const { a: port1, b: port2 } = createPortPair();
  // bridge 持有 port1,Host 侧必须终结 port2(与真实 MessageChannelMain 两端一致)。
  const hostProtocol = new MessagePortProtocol(toLike(port2));

  const posted: Array<{ type: string; attachmentId: string }> = [];
  const fakeHostProcess = {
    pid: 1234,
    postMessage(message: { type: string; attachmentId: string }) {
      posted.push(message);
    },
  };

  const attach = attachMobileDirectClient({
    win: { webContents: { id: 7 } } as never,
    hostProcess: fakeHostProcess as never,
    createMessageChannel: () => ({ port1: port1 as never, port2: port2 as never }),
    logger: { info() {}, warn() {} },
  });

  const socket = createFakeSocket();
  const detach = attach.connectSocket(socket);
  await tick();

  assert.equal(posted.length, 1, "应发出一次 AttachServicePort");
  assert.equal(posted[0].type, "attach-service-port");
  const clientAttachmentId = posted[0].attachmentId;

  // ---- 手机 → Host:裸远端灌一条完整帧,Host 侧 MessagePortProtocol 应收到 payload ----
  const hostReceived: Uint8Array[] = [];
  hostProtocol.onMessage((buffer) => hostReceived.push(buffer.buffer.slice()));

  socket.feed(frameMessage(new TextEncoder().encode("hello-from-phone")));
  await tick();
  assert.equal(hostReceived.length, 1, "Host 应收到 1 条手机消息");
  assert.equal(
    new TextDecoder().decode(hostReceived[0]),
    "hello-from-phone",
    "Host 收到的字节应与手机发送一致",
  );

  // ---- Host → 手机:Host 侧发消息,bridge 应组帧写回 WS ----
  hostProtocol.send(VSBuffer.wrap(new TextEncoder().encode("hello-from-host")));
  await tick();
  assert.equal(socket.sentToClient.length, 1, "手机应收到 1 条 Host 消息");
  assert.equal(
    new TextDecoder().decode(unframe(socket.sentToClient[0])),
    "hello-from-host",
    "手机收到的字节应与 Host 发送一致",
  );

  // ---- 分帧健壮性:把一条帧拆成两半喂入,应仍能重组 ----
  const framed = frameMessage(new TextEncoder().encode("split-message"));
  const half = Math.floor(framed.length / 2);
  socket.feed(framed.subarray(0, half));
  await tick();
  assert.equal(hostReceived.length, 1, "半个帧不应提前产出消息");
  socket.feed(framed.subarray(half));
  await tick();
  assert.equal(hostReceived.length, 2, "补齐后半帧后应产出消息");
  assert.equal(new TextDecoder().decode(hostReceived[1]), "split-message");

  // ---- 断开:detach 应通知 Host detach,并且连接数归零 ----
  assert.equal(attach.attachment.connectionCount, 1, "应记录 1 个连接");
  detach();
  assert.equal(attach.attachment.connectionCount, 0, "detach 后连接数应为 0");
  assert.ok(
    posted.some(
      (m) => m.type === "detach-service-port" && m.attachmentId === clientAttachmentId,
    ),
    "detach 应用同一个 attachmentId 通知 Host",
  );

  // ---- Host 端口关闭应同步收掉 WS ----
  const socket2 = createFakeSocket();
  attach.connectSocket(socket2);
  await tick();
  let ended = false;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  socket2.onEnd(() => {
    ended = true;
  });
  port1.close();
  await tick();
  assert.equal(ended, true, "Host 端口 close 应同步 end 掉手机 WS");

  console.log("mobile-direct bridge runtime smoke: OK");
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
