import { Adb, AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InputLeapClient } from "./input-leap/client.js";
import { Lazy } from "./lazy.js";
import { RotationMapper } from "./rotation.js";
import { ServerClient, ServerUHidDevice } from "./server.js";
import { loadMouseSettings, AccelerationFilter } from "./acceleration.js";
import { HidKeyboard } from "./keyboard.js";
import { execSync } from "node:child_process";
import net from "node:net";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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

try {
  execSync("adb forward tcp:18400 tcp:18400");
  console.log("[cursor-overlay] Set up ADB port forwarding for cursor service");
} catch (e) {
  console.error("[cursor-overlay] Failed to set up ADB port forwarding:", e);
}

const apkPath = resolve(LocalRoot, "server/app/build/outputs/apk/debug/app-debug.apk");

// Only install APK if it has changed (compare local hash vs stored hash on device)
const localApkHash = createHash("md5").update(readFileSync(apkPath)).digest("hex");
const remoteHashPath = "/data/local/tmp/leap-scrcpy-apk.md5";
let remoteHash = "";
try {
  remoteHash = execSync(`adb shell cat "${remoteHashPath}" 2>/dev/null`).toString().trim();
} catch (e) {}

if (localApkHash !== remoteHash) {
  console.log("[cursor-overlay] APK changed, installing...");
  try {
    execSync(`adb install -r -d "${apkPath}"`);
    execSync(`adb shell "echo ${localApkHash} > ${remoteHashPath}"`);
    console.log("[cursor-overlay] Helper app installed successfully");
  } catch (e) {
    console.error("[cursor-overlay] Failed to install helper app:", e);
  }
} else {
  console.log("[cursor-overlay] APK is up to date, skipping install.");
}

// 2. Grant overlay permission via appops
try {
  execSync("adb shell appops set leap.scrcpy.server SYSTEM_ALERT_WINDOW allow");
  console.log("[cursor-overlay] Granted overlay permission via ADB");
} catch (e) {
  console.warn("[cursor-overlay] Warning: Failed to grant overlay permission via ADB:", e);
}

// 3. Check if Accessibility Service is enabled, if not start MainActivity to prompt user
let isServiceEnabled = false;
try {
  const enabledServices = execSync("adb shell settings get secure enabled_accessibility_services").toString();
  if (
    enabledServices.includes("leap.scrcpy.server/.CursorAccessibilityService") ||
    enabledServices.includes("leap.scrcpy.server/leap.scrcpy.server.CursorAccessibilityService")
  ) {
    isServiceEnabled = true;
  }
} catch (e) {}

if (!isServiceEnabled) {
  console.log("[cursor-overlay] Accessibility service is not enabled. Launching MainActivity...");
  try {
    execSync("adb shell am start -n leap.scrcpy.server/.MainActivity");
    console.log("[cursor-overlay] MainActivity launched");
  } catch (e) {
    console.error("[cursor-overlay] Failed to start MainActivity:", e);
  }
} else {
  console.log("[cursor-overlay] Accessibility service is already running. Skipping MainActivity.");
}

let cursorSocket: net.Socket | null = null;
let isCursorConnected = false;

function connectCursor() {
  if (isCursorConnected || cursorSocket) return;

  const socket = new net.Socket();
  cursorSocket = socket;

  socket.connect(18400, "127.0.0.1", () => {
    isCursorConnected = true;
    console.log("[cursor-overlay] Connected to Android cursor overlay");
    if (typeof rotationMapper !== "undefined" && rotationMapper) {
      sendCursorSize(rotationMapper.logicalWidth, rotationMapper.logicalHeight);
    }
  });

  socket.on("error", () => {
    isCursorConnected = false;
    cursorSocket = null;
  });

  socket.on("close", () => {
    isCursorConnected = false;
    cursorSocket = null;
    // Retry connection after 3 seconds
    setTimeout(connectCursor, 3000);
  });
}

function sendCursorShow() {
  if (!isCursorConnected || !cursorSocket) return;
  const buf = Buffer.alloc(1);
  buf.writeUInt8(1, 0); // 1 = Show
  cursorSocket.write(buf);
}

function sendCursorHide() {
  if (!isCursorConnected || !cursorSocket) return;
  const buf = Buffer.alloc(1);
  buf.writeUInt8(0, 0); // 0 = Hide
  cursorSocket.write(buf);
}

function sendCursorMove(x: number, y: number) {
  if (!isCursorConnected || !cursorSocket) return;
  const buf = Buffer.alloc(9);
  buf.writeUInt8(2, 0); // 2 = Move
  buf.writeInt32BE(Math.round(x), 1);
  buf.writeInt32BE(Math.round(y), 5);
  cursorSocket.write(buf);
}

function sendCursorSize(width: number, height: number) {
  if (!isCursorConnected || !cursorSocket || width <= 0 || height <= 0) return;
  const buf = Buffer.alloc(9);
  buf.writeUInt8(3, 0); // 3 = Set Size
  buf.writeInt32BE(Math.round(width), 1);
  buf.writeInt32BE(Math.round(height), 5);
  cursorSocket.write(buf);
}

const rotationMapper = new RotationMapper();

let currentButtonState = 0;

function mapButton(button: number): number {
  if (button === 1) return 1; // Left -> Primary (1)
  if (button === 2) return 4; // Middle -> Tertiary (4)
  if (button === 3) return 2; // Right -> Secondary (2)
  if (button === 4) return 8; // Back -> Back (8)
  if (button === 5) return 16; // Forward -> Forward (16)
  return 0;
}

connectCursor();


const server = await ServerClient.start(
  adb,
  resolve(LocalRoot, "server/app/build/outputs/apk/debug/app-debug.apk"),
);


const mouseSettings = await loadMouseSettings();
const accelFilter = new AccelerationFilter(mouseSettings);

let lastX = 0;
let lastY = 0;
let virtualX = 0;
let virtualY = 0;
let isInitialized = false;




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

      sendCursorMove(x, y);
      
      rotationMapper.setLogicalPosition(x, y);
      const action = currentButtonState !== 0 ? 2 : 7; // ACTION_MOVE (2) or ACTION_HOVER_MOVE (7)
      await server.injectInput(
        action,
        x,
        y,
        currentButtonState,
        0,
        0
      );
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

    sendCursorShow();
    sendCursorMove(x, y);

    rotationMapper.setLogicalPosition(x, y);
    server.injectInput(
      7, // ACTION_HOVER_MOVE
      x,
      y,
      currentButtonState,
      0,
      0
    );
  });

  client.onLeave(() => {
    isInitialized = false;
    sendCursorHide();
    currentButtonState = 0;
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
    const mask = mapButton(button);
    currentButtonState |= mask;
    rotationMapper.setLogicalPosition(virtualX, virtualY);
    server.injectInput(
      0, // ACTION_DOWN
      virtualX,
      virtualY,
      currentButtonState,
      0,
      0
    );
  });

  client.onMouseUp((button) => {
    const mask = mapButton(button);
    currentButtonState &= ~mask;
    rotationMapper.setLogicalPosition(virtualX, virtualY);
    server.injectInput(
      1, // ACTION_UP
      virtualX,
      virtualY,
      currentButtonState,
      0,
      0
    );
  });

  client.onMouseWheel(({ yDelta }) => {
    const vscroll = Math.sign(yDelta);
    rotationMapper.setLogicalPosition(virtualX, virtualY);
    server.injectInput(
      8, // ACTION_SCROLL
      virtualX,
      virtualY,
      currentButtonState,
      vscroll,
      0
    );
  });

  client.onClipboard((content) => {
    server.setClipboard(content);
  });

  const keyboard = new HidKeyboard();
  const keyboardDevice = await server.createUHidDevice(
    1, // SC_HID_ID_KEYBOARD
    HidKeyboard.getDescriptor()
  );

  client.onKeyDown(({ id, mask, button }) => {
    const scancode = HidKeyboard.windowsScanCodeToHid(button);
    if (scancode) {
      keyboard.setModifiers(mask);
      keyboard.keyDown(scancode);
      keyboardDevice.write(keyboard.report);
    }
  });

  client.onKeyUp(({ id, mask, button }) => {
    const scancode = HidKeyboard.windowsScanCodeToHid(button);
    if (scancode) {
      keyboard.setModifiers(mask);
      keyboard.keyUp(scancode);
      keyboardDevice.write(keyboard.report);
    }
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

  virtualX = Math.max(0, Math.min(rotationMapper.logicalWidth, virtualX));
  virtualY = Math.max(0, Math.min(rotationMapper.logicalHeight, virtualY));

  sendCursorSize(rotationMapper.logicalWidth, rotationMapper.logicalHeight);
});

server.onClipboardChange(async (content) => {
  const inputLeapClient = await inputLeapLazy.get();
  inputLeapClient.setClipboard(content);
});
