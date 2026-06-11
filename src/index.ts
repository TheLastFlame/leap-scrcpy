import { Adb, AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InputLeapClient } from "./input-leap/client.js";
import { Lazy } from "./lazy.js";
import { RotationMapper } from "./rotation.js";
import { ServerClient } from "./server.js";
import { HidStylus } from "./stylus.js";
import { loadMouseSettings, AccelerationFilter } from "./acceleration.js";

const address = process.argv[2] ?? "localhost:24800";
const name = process.argv[3] ?? "Android";

const [host, port] = address.split(":");
if (!host || !port) {
  console.log("Usage: leap-scrcpy <server-address>");
  process.exit(1);
}

const adbClient = new AdbServerClient(
  new AdbServerNodeTcpConnector({ host: "127.0.0.1", port: 5037 }),
);

const devices = await adbClient.getDevices();
if (devices.length === 0) {
  console.log("No device found");
  process.exit(2);
}

export const adb = new Adb(await adbClient.createTransport(devices[0]));
console.log("using device", adb.serial);

export const LocalRoot = resolve(fileURLToPath(import.meta.url), "../..");

const server = await ServerClient.start(
  adb,
  resolve(LocalRoot, "server/app/build/outputs/apk/debug/app-debug.apk"),
);

const rotationMapper = new RotationMapper();
const stylus = new HidStylus();
const uHidStylus = await server.createUHidDevice(0, HidStylus.Descriptor);

const mouseSettings = await loadMouseSettings();
const accelFilter = new AccelerationFilter(mouseSettings);

let lastX = 0;
let lastY = 0;
let virtualX = 0;
let virtualY = 0;
let isInitialized = false;

let writeLock: Promise<void> = Promise.resolve();
function safeWrite(report: Uint8Array): Promise<void> {
  const serialized = writeLock.then(() => uHidStylus.write(report));
  writeLock = serialized.catch(() => {});
  return serialized;
}

let isWritingMove = false;
let hasPendingMove = false;
let pendingX = 0;
let pendingY = 0;

async function sendMouseMove() {
  if (isWritingMove) {
    return;
  }
  isWritingMove = true;
  try {
    while (hasPendingMove) {
      const x = pendingX;
      const y = pendingY;
      hasPendingMove = false;

      rotationMapper.setLogicalPosition(x, y);
      stylus!.move(rotationMapper.x, rotationMapper.y);
      await safeWrite(stylus!.report.slice());
    }
  } finally {
    isWritingMove = false;
  }
}

const inputLeapLazy = new Lazy(async (width: number, height: number) => {
  const client = await InputLeapClient.connect(
    {
      host,
      port: Number.parseInt(port, 10),
    },
    name,
    width,
    height,
  );

  console.log("[deskflow]", "server connected");

  client.onEnter(({ x, y }) => {
    lastX = x;
    lastY = y;
    virtualX = x;
    virtualY = y;
    isInitialized = true;

    rotationMapper.setLogicalPosition(x, y);

    stylus!.enter();
    stylus!.move(rotationMapper.x, rotationMapper.y);

    safeWrite(stylus!.report.slice());
  });

  client.onLeave(() => {
    isInitialized = false;
    stylus!.leave();
    safeWrite(stylus!.report.slice());
  });

  client.onMouseMove(({ x, y }) => {
    if (!isInitialized) {
      lastX = x;
      lastY = y;
      virtualX = x;
      virtualY = y;
      isInitialized = true;
    }

    const rawDx = x - lastX;
    const rawDy = y - lastY;
    lastX = x;
    lastY = y;

    if (rawDx === 0 && rawDy === 0) {
      return;
    }

    const { dx, dy } = accelFilter.apply(rawDx, rawDy);

    virtualX = Math.max(0, Math.min(rotationMapper.logicalWidth, virtualX + dx));
    virtualY = Math.max(0, Math.min(rotationMapper.logicalHeight, virtualY + dy));

    pendingX = virtualX;
    pendingY = virtualY;
    hasPendingMove = true;
    sendMouseMove();
  });

  client.onMouseDown((button) => {
    stylus!.buttonDown(button);
    safeWrite(stylus!.report.slice());
  });

  client.onMouseUp((button) => {
    stylus!.buttonUp(button);
    safeWrite(stylus!.report.slice());
  });

  client.onClipboard((content) => {
    server.setClipboard(content);
  });

  return client;
});

server.onDisplayChange(async ({ width, height, rotation }) => {
  rotationMapper.setSize(width, height);
  rotationMapper.setRotation(rotation);

  if (!inputLeapLazy.hasValue) {
    inputLeapLazy.getOrCreate(
      rotationMapper.logicalWidth,
      rotationMapper.logicalHeight,
    );
  } else {
    const inputLeapClient = await inputLeapLazy.get();
    inputLeapClient.setSize(
      rotationMapper.logicalWidth,
      rotationMapper.logicalHeight,
      rotationMapper.logicalX,
      rotationMapper.logicalY,
    );
  }

  stylus.setSize(rotationMapper.logicalWidth, rotationMapper.logicalHeight);
  virtualX = rotationMapper.x;
  virtualY = rotationMapper.y;
  stylus.move(rotationMapper.x, rotationMapper.y);

  await safeWrite(stylus.report.slice());
});

server.onClipboardChange(async (content) => {
  const inputLeapClient = await inputLeapLazy.get();
  inputLeapClient.setClipboard(content);
});
