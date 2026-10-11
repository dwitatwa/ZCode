import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { UtilityProcess as ElectronUtilityProcess, MessagePortMain } from "electron";
import {
  DisposableStore,
  MessagePortProtocol,
  SocketProtocol,
  VSBuffer,
  type ISocket,
  type MessagePortLike,
  type MessagePortPayload,
} from "@zcode/rpc";
import { HostMessageTypes } from "@zcode/shared";

/**
 * 直连移动远控的传输桥。
 *
 * 桌面窗口 Host 通过 MessagePort 暴露 local services(exposeServicesOnMessagePort →
 * MessagePortProtocol,每条 port 消息即一条完整 RPC 消息);手机浏览器走 WebSocket
 * (SocketProtocol,13 字节帧头 + 流式重组)。
 *
 * 两端负载都是同一个 RPC 消息字节序列,所以这里不做字节管道,而是各自终结一层协议、
 * 转发「消息负载」:
 *
 *   phone ──WS──> SocketProtocol.onMessage(bytes) ──> portProtocol.send(bytes) ──> Host
 *   phone <──WS── SocketProtocol.send(bytes)     <── portProtocol.onMessage(bytes) <── Host
 *
 * 注意:MessagePortProtocol 还会产出 flow-control 控制对象(无 SocketProtocol 对应物),
 * 已在 protocol 层被分流丢弃;因此 v1 的 WS 侧没有传输级背压,由 RPC 层自身高水位兜底。
 */

export interface MobileDirectAttachment {
  /** 底层 Host 进程,用于 detach / 生命周期判断。 */
  readonly hostProcess: ElectronUtilityProcess;
  /** 已建立 attachment 的窗口 webContents id(用于定位所属窗口)。 */
  readonly ownerWebContentsId: number;
  /** 当前已经桥接的移动客户端数量。 */
  readonly connectionCount: number;
  /** 关闭该 attachment:断开所有 Host 端口并通知 Host detach。 */
  dispose(): void;
}

interface ActiveBridge {
  /** Host 侧 attachment 标识;detach 必须与 attach 时一致,否则会留下悬空 attachment。 */
  attachmentId: string;
  wsSocket: ISocket;
  portProtocol: MessagePortProtocol;
  disposables: DisposableStore;
  closed: boolean;
}

/** 与 wrapElectronPort 同构;bridge 自己持有端口,便于统一 dispose。 */
function toMessagePortLike(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type, listener) {
      port.on("message", listener as (e: { data: MessagePortPayload }) => void);
    },
    removeEventListener(_type, listener) {
      port.off("message", listener as (e: { data: MessagePortPayload }) => void);
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

export interface MobileDirectBridgeLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
}

export interface MobileDirectAttachHandle {
  attachmentId: string;
  attachment: MobileDirectAttachment;
  /** 把一个 WebSocket 接入当前 attachment。返回 detach 该客户端的 disposer。 */
  connectSocket(socket: ISocket): () => void;
}

/**
 * 建立「手机 ↔ 桌面窗口 Host」的 attachment。
 *
 * clientMode 用 web-remote-replayable:与手机远控语义一致,Host 侧
 * exposeServicesOnMessagePort 会据此装配 controller-routed task service 与
 * agent connection scope,避免错误地要求 desktop-continuous 的实时语义。
 */
export function attachMobileDirectClient(params: {
  win: BrowserWindow;
  hostProcess: ElectronUtilityProcess;
  createMessageChannel: () => { port1: MessagePortMain; port2: MessagePortMain };
  logger: MobileDirectBridgeLogger;
  onClosed?: () => void;
}): MobileDirectAttachHandle {
  const { win, hostProcess, createMessageChannel, logger } = params;
  const ownerWebContentsId = win.webContents.id;
  const bridges = new Set<ActiveBridge>();
  let disposed = false;

  const attachmentId = randomUUID();

  const closeBridge = (bridge: ActiveBridge): void => {
    if (bridge.closed) return;
    bridge.closed = true;
    bridge.disposables.dispose();
    bridges.delete(bridge);
    bridge.portProtocol.disconnect();
    bridge.wsSocket.dispose();
    // 显式 detach 这个客户端在 Host 侧的 attachment,避免 Host 在窗口存活期间累积悬空端口。
    try {
      hostProcess.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: bridge.attachmentId,
      });
    } catch (error) {
      logger.warn("[mobile-direct] detach client service port failed", {
        attachmentId: bridge.attachmentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const bridge of Array.from(bridges)) {
      closeBridge(bridge);
    }
    params.onClosed?.();
  };

  const attachment: MobileDirectAttachment = {
    hostProcess,
    ownerWebContentsId,
    get connectionCount() {
      return bridges.size;
    },
    dispose,
  };

  /**
   * 每个移动客户端独立建立一条 Host 端口 + 一组协议终结。
   *
   * 不能复用同一条端口:Host 的 MessagePortProtocol 没有多路复用语义,
   * 多个客户端共用会让两条链路的 RPC 消息交错。独立端口天然隔离。
   */
  const connectSocket = (wsSocket: ISocket): (() => void) => {
    if (disposed) {
      wsSocket.dispose();
      return () => undefined;
    }

    const { port1, port2 } = createMessageChannel();
    const clientAttachmentId = randomUUID();
    try {
      hostProcess.postMessage(
        {
          type: HostMessageTypes.AttachServicePort,
          requestId: randomUUID(),
          attachmentId: clientAttachmentId,
          clientMode: "web-remote-replayable",
          scope: { kind: "local" },
        },
        [port2],
      );
    } catch (error) {
      // 端口可能已转移;失败时关闭两端,避免 Host 侧留下悬空 attachment。
      port1.close();
      port2.close();
      wsSocket.dispose();
      logger.warn("[mobile-direct] attach service port failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return () => undefined;
    }

    const portProtocol = new MessagePortProtocol(toMessagePortLike(port1));
    const socketProtocol = new SocketProtocol(wsSocket);

    const bridge: ActiveBridge = {
      attachmentId: clientAttachmentId,
      wsSocket,
      portProtocol,
      disposables: new DisposableStore(),
      closed: false,
    };

    // Host → phone:MessagePortProtocol 已把 control 对象与 Uint8Array 分流,
    // onMessage 只会给出真实 RPC 字节;SocketProtocol 自动补帧头写回 WS。
    bridge.disposables.add(
      portProtocol.onMessage((buffer) => {
        if (bridge.closed) return;
        socketProtocol.send(buffer);
      }),
    );

    // phone → Host:SocketProtocol 已完成拆帧,得到完整 RPC 消息,原样投进端口。
    bridge.disposables.add(
      socketProtocol.onMessage((buffer: VSBuffer) => {
        if (bridge.closed) return;
        portProtocol.send(buffer);
      }),
    );

    const handleSocketClose = () => closeBridge(bridge);
    bridge.disposables.add(wsSocket.onClose(handleSocketClose));
    bridge.disposables.add(wsSocket.onEnd(handleSocketClose));

    // Host 端口关闭(窗口关闭 / 服务销毁)时同步收掉 WS,避免手机侧静默挂起。
    const handlePortClose = () => {
      try {
        wsSocket.end();
      } catch {
        /* 幂等 */
      }
      closeBridge(bridge);
    };
    port1.once("close", handlePortClose);

    bridges.add(bridge);
    logger.info("[mobile-direct] client bridged", { attachmentId });

    return () => closeBridge(bridge);
  };

  return { attachmentId, attachment, connectSocket };
}