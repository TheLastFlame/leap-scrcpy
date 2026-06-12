import { Adb, AdbNoneProtocolProcess } from "@yume-chan/adb";
import { EventEmitter } from "@yume-chan/event";
import type { WritableStreamDefaultWriter } from "@yume-chan/stream-extra";
import {
  MaybeConsumable,
  ReadableStream,
  StructDeserializeStream,
  WritableStream,
} from "@yume-chan/stream-extra";
import { buffer, s32, string, struct, StructInit } from "@yume-chan/struct";
import { createReadStream } from "fs";
import net from "node:net";
import { UHidBus, UHidCreate2, UHidEventType, UHidInput2 } from "./uhid.js";
import { union } from "./union.js";

export const VersionMessage = struct(
  { major: s32, minor: s32 },
  { littleEndian: false },
);

export const DisplayInfoMessage = struct(
  { width: s32, height: s32, rotation: s32 },
  { littleEndian: false },
);

export const ClipboardMessage = struct(
  { content: string(s32) },
  { littleEndian: false },
);

export const UHidMessage = struct(
  { id: s32, data: buffer(s32) },
  { littleEndian: false },
);

export const MessageId = {
  Version: 0,
  DisplayInfo: 1,
  ClipboardChange: 2,
  UHidOutput: 3,
} as const;

export const Messages = struct(
  {
    value: union({ type: s32 }, {
      [MessageId.Version]: VersionMessage,
      [MessageId.DisplayInfo]: DisplayInfoMessage,
      [MessageId.ClipboardChange]: ClipboardMessage,
      [MessageId.UHidOutput]: UHidMessage,
    } as const),
  },
  { littleEndian: false },
);

export const ClipboardRequest = struct(
  { content: string(s32) },
  { littleEndian: false },
);

export const InjectRequest = struct(
  {
    action: s32,
    x: s32,
    y: s32,
    buttonState: s32,
    vscroll: s32,
    hscroll: s32,
  },
  { littleEndian: false },
);

export const UHidRequestOperation = {
  Create: 0,
  Write: 1,
} as const;

export type UHidRequestOperation =
  (typeof UHidRequestOperation)[keyof typeof UHidRequestOperation];

export const UHidRequest = struct(
  { operation: s32<UHidRequestOperation>(), id: s32, data: buffer(s32) },
  { littleEndian: false },
);

export const RequestId = {
  SetClipboard: 0,
  UHidRequest: 1,
  InjectRequest: 2,
} as const;

export const Requests = struct(
  {
    value: union(
      { type: s32 },
      {
        [RequestId.SetClipboard]: ClipboardRequest,
        [RequestId.UHidRequest]: UHidRequest,
        [RequestId.InjectRequest]: InjectRequest,
      },
    ),
  },
  { littleEndian: false },
);

const ServerPath = "/data/local/tmp/leap-scrcpy.jar";

export class ServerClient {
  static async start(adb: Adb, serverPath: string) {
    const sync = await adb.sync();
    try {
      console.log("[server]", "server path", serverPath);
      await sync.write({
        filename: ServerPath,
        file: ReadableStream.from(createReadStream(serverPath)),
      });
    } finally {
      await sync.dispose();
    }

    const process = await adb.subprocess.noneProtocol.spawn([
      "app_process",
      "-cp",
      ServerPath,
      "/",
      "leap.scrcpy.server.Main",
    ]);

    // Give the Android server a brief moment to start
    await new Promise(resolve => setTimeout(resolve, 300));

    let controlSocket: net.Socket;
    while (true) {
      controlSocket = new net.Socket();
      try {
        await new Promise<void>((resolve, reject) => {
          const onErr = (e: Error) => reject(e);
          controlSocket.once("error", onErr);
          controlSocket.connect(18402, "127.0.0.1", () => {
            controlSocket.removeListener("error", onErr);
            resolve();
          });
        });

        // ADB will accept the connection locally even if the Android app isn't listening,
        // but it will immediately close the socket. We wait a tiny bit to see if it closes.
        await new Promise<void>((resolve, reject) => {
          const onClose = () => reject(new Error("Socket closed immediately by ADB"));
          controlSocket.once("close", onClose);
          setTimeout(() => {
            controlSocket.removeListener("close", onClose);
            resolve();
          }, 50);
        });

        break; // Successfully connected and stayed open!
      } catch (e) {
        controlSocket.destroy();
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    controlSocket.setNoDelay(true);

    return new ServerClient(process, controlSocket);
  }

  #process: AdbNoneProtocolProcess;
  #writer: WritableStreamDefaultWriter<MaybeConsumable<Uint8Array>>;

  #ready = false;

  #displayInfo?: { width: number; height: number; rotation: number; };
  get displayInfo() {
    return this.#displayInfo;
  }

  #onDisplayChange = new EventEmitter<{
    width: number;
    height: number;
    rotation: number;
  }>();
  get onDisplayChange() {
    return this.#onDisplayChange.event;
  }

  #onClipboardChange = new EventEmitter<string>();
  get onClipboardChange() {
    return this.#onClipboardChange.event;
  }

  constructor(process: AdbNoneProtocolProcess, controlSocket: net.Socket) {
    this.#process = process;
    
    const writeToSocket = new WritableStream<MaybeConsumable<Uint8Array>>({
      write: (chunk) => {
        return new Promise<void>((resolve, reject) => {
          const buffer = chunk instanceof Uint8Array ? chunk : chunk.value;
          controlSocket.write(buffer, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    });
    this.#writer = writeToSocket.getWriter();

    const handleMessage = ({ value: message }: any) => {
      console.log(`[server] Received raw message type: ${message.type}`);
      switch (message.type) {
        case MessageId.Version:
          if (this.#ready) {
            throw new Error("Invalid protocol data");
          }
          if (message.major > 1) {
            throw new Error("Incompatible version");
          }
          this.#ready = true;
          break;
        case MessageId.DisplayInfo:
          if (!this.#ready) {
            throw new Error("Invalid protocol data");
          }
          this.#displayInfo = message;
          this.#onDisplayChange.fire(message);
          break;
        case MessageId.ClipboardChange:
          if (!this.#ready) {
            throw new Error("Invalid protocol data");
          }
          this.#onClipboardChange.fire(message.content);
          break;
        case MessageId.UHidOutput:
          if (!this.#ready) {
            throw new Error("Invalid protocol data");
          }
          break;
      }
    };

    // Read initial messages (Version, DisplayInfo) from stdout
    void this.#process.output
      .pipeThrough(new StructDeserializeStream(Messages))
      .pipeTo(new WritableStream({ write: handleMessage }))
      .catch((err) => {
        console.error("[server] Output stream processing error:", err);
      });

    // Read continuous messages (Clipboard) from the control socket
    void ReadableStream.from<Uint8Array>(controlSocket)
      .pipeThrough(new StructDeserializeStream(Messages))
      .pipeTo(new WritableStream({ write: handleMessage }))
      .catch((err) => {
        console.error("[server] Socket stream processing error:", err);
      });
  }

  #write(request: StructInit<typeof Requests>["value"]) {
    const buffer = Requests.serialize({ value: request });
    // console.log("[server]", "write", buffer);
    return this.#writer.write(buffer);
  }

  setClipboard(content: string) {
    return this.#write({ type: 0, content });
  }

  injectInput(
    action: number,
    x: number,
    y: number,
    buttonState: number,
    vscroll: number,
    hscroll: number,
  ) {
    return this.#write({
      type: RequestId.InjectRequest,
      action,
      x,
      y,
      buttonState,
      vscroll,
      hscroll,
    });
  }

  async createUHidDevice(id: number, descriptor: Uint8Array) {
    await this.#write({
      type: RequestId.UHidRequest,
      operation: UHidRequestOperation.Create,
      id,
      data: UHidCreate2.serialize({
        type: UHidEventType.Create2,
        name: "input-scrcpy",
        phys: "",
        uniq: new Uint8Array(0),
        bus: UHidBus.Virtual,
        product: 0x0000,
        vendor: 0x0000,
        version: 0x0000,
        country: 0,
        rd_data: descriptor,
      }),
    });

    return new ServerUHidDevice(id, this.#writer);
  }

  stop() {
    return this.#process.kill();
  }
}

export class ServerUHidDevice {
  #id: number;
  #writer: WritableStreamDefaultWriter<MaybeConsumable<Uint8Array>>;

  constructor(
    id: number,
    writer: WritableStreamDefaultWriter<MaybeConsumable<Uint8Array>>,
  ) {
    this.#id = id;
    this.#writer = writer;
  }

  #write(request: StructInit<typeof Requests>["value"]) {
    const buffer = Requests.serialize({ value: request });
    // console.log("[server]", "write", buffer);
    return this.#writer.write(buffer);
  }

  write(report: Uint8Array) {
    return this.#write({
      type: RequestId.UHidRequest,
      operation: UHidRequestOperation.Write,
      id: this.#id,
      data: UHidInput2.serialize({
        type: UHidEventType.Input2,
        data: report,
      }),
    });
  }
}
