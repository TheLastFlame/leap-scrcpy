import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface MouseSettings {
  accelEnabled: boolean;
  sensitivity: number;
  curveX: number[];
  curveY: number[];
  touchpadSpeed: number | null;
}

const DEFAULT_CURVE_X = [0, 0.4300079, 1.25, 3.8600006, 40];
const DEFAULT_CURVE_Y = [0, 1.0702667, 4.140625, 18.984375, 443.75];

const SENSITIVITY_TABLE: Record<number, number> = {
  1: 1 / 32,
  2: 1 / 16,
  3: 1 / 8,
  4: 2 / 8,
  5: 3 / 8,
  6: 4 / 8,
  7: 5 / 8,
  8: 6 / 8,
  9: 7 / 8,
  10: 1.0,
  11: 1.25,
  12: 1.5,
  13: 1.75,
  14: 2.0,
  15: 2.25,
  16: 2.5,
  17: 2.75,
  18: 3.0,
  19: 3.25,
  20: 3.5,
};

function parseFixedPoint(hex: string): number {
  if (hex.length < 8) return 0;
  const b0 = Number.parseInt(hex.slice(0, 2), 16) || 0;
  const b1 = Number.parseInt(hex.slice(2, 4), 16) || 0;
  const b2 = Number.parseInt(hex.slice(4, 6), 16) || 0;
  const b3 = Number.parseInt(hex.slice(6, 8), 16) || 0;
  const val = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
  return val / 65536;
}

function parseCurve(hexStr: string): number[] {
  const cleanHex = hexStr.replace(/[^0-9A-Fa-f]/g, "");
  const curve: number[] = [];
  for (let i = 0; i < 5; i++) {
    const offset = i * 16;
    if (offset + 8 <= cleanHex.length) {
      const part = cleanHex.slice(offset, offset + 8);
      curve.push(parseFixedPoint(part));
    } else {
      break;
    }
  }
  return curve;
}

export async function loadMouseSettings(): Promise<MouseSettings> {
  const settings: MouseSettings = {
    accelEnabled: true,
    sensitivity: 10,
    curveX: [...DEFAULT_CURVE_X],
    curveY: [...DEFAULT_CURVE_Y],
    touchpadSpeed: null,
  };

  if (process.platform !== "win32") {
    return settings;
  }

  // 1. Load Mouse settings
  try {
    const { stdout } = await execAsync('reg query "HKCU\\Control Panel\\Mouse"');
    
    // Parse MouseSpeed (accel enabled)
    const speedMatch = /MouseSpeed\s+REG_SZ\s+(\d+)/.exec(stdout);
    if (speedMatch) {
      settings.accelEnabled = speedMatch[1] !== "0";
    }

    // Parse MouseSensitivity
    const sensMatch = /MouseSensitivity\s+REG_SZ\s+(\d+)/.exec(stdout);
    if (sensMatch) {
      settings.sensitivity = Number.parseInt(sensMatch[1], 10);
    }

    // Parse Curves
    const curveXMatch = /SmoothMouseXCurve\s+REG_BINARY\s+([0-9A-Fa-f]+)/.exec(stdout);
    if (curveXMatch) {
      const parsedX = parseCurve(curveXMatch[1]);
      if (parsedX.length === 5) {
        settings.curveX = parsedX;
      }
    }

    const curveYMatch = /SmoothMouseYCurve\s+REG_BINARY\s+([0-9A-Fa-f]+)/.exec(stdout);
    if (curveYMatch) {
      const parsedY = parseCurve(curveYMatch[1]);
      if (parsedY.length === 5) {
        settings.curveY = parsedY;
      }
    }
  } catch (err) {
    console.warn("[accel] Failed to read registry mouse settings, using defaults:", err);
  }

  // 2. Load Precision Touchpad settings if available
  try {
    const { stdout } = await execAsync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PrecisionTouchpad"');
    const tpSpeedMatch = /CursorSpeed\s+REG_DWORD\s+0x([0-9A-Fa-f]+)/.exec(stdout);
    if (tpSpeedMatch) {
      settings.touchpadSpeed = Number.parseInt(tpSpeedMatch[1], 16);
    }
  } catch (err) {
    // Touchpad settings not found or not on a laptop, that's fine
  }

  return settings;
}

export class AccelerationFilter {
  private settings: MouseSettings;
  private sensitivityMult = 1.0;
  private accelScale = 1.0;

  constructor(settings: MouseSettings) {
    this.settings = settings;

    // Determine whether to use touchpad or mouse sensitivity
    const useTouchpad = process.env.TOUCHPAD !== "false" && settings.touchpadSpeed !== null;
    const finalSensitivity = useTouchpad ? (settings.touchpadSpeed as number) : settings.sensitivity;

    this.sensitivityMult = SENSITIVITY_TABLE[finalSensitivity] ?? 1.0;
    
    // Custom scaling factor via env
    if (process.env.ACCEL_SCALE) {
      const scale = Number.parseFloat(process.env.ACCEL_SCALE);
      if (!Number.isNaN(scale)) {
        this.accelScale = scale;
      }
    }

    console.log(
      `[accel] Mouse acceleration initialized. AccelEnabled: ${settings.accelEnabled}, ` +
      `Sensitivity: ${finalSensitivity} (multiplier: ${this.sensitivityMult}), ` +
      `TouchpadMode: ${useTouchpad}, AccelScale: ${this.accelScale}`
    );
  }

  private interpolateY(x: number): number {
    const { curveX, curveY } = this.settings;
    if (x <= curveX[0]) return curveY[0];
    if (x >= curveX[curveX.length - 1]) {
      const last = curveX.length - 1;
      const slope = (curveY[last] - curveY[last - 1]) / (curveX[last] - curveX[last - 1]);
      return curveY[last] + (x - curveX[last]) * slope;
    }
    for (let i = 0; i < curveX.length - 1; i++) {
      if (x >= curveX[i] && x <= curveX[i + 1]) {
        const t = (x - curveX[i]) / (curveX[i + 1] - curveX[i]);
        return curveY[i] + t * (curveY[i + 1] - curveY[i]);
      }
    }
    return x;
  }

  public apply(dx: number, dy: number): { dx: number; dy: number } {
    if (!this.settings.accelEnabled || process.env.ACCEL_DISABLED === "true") {
      // Linear sensitivity mapping
      return {
        dx: dx * this.sensitivityMult * this.accelScale,
        dy: dy * this.sensitivityMult * this.accelScale,
      };
    }

    const speed = Math.sqrt(dx * dx + dy * dy);
    if (speed === 0) {
      return { dx: 0, dy: 0 };
    }

    // Get the accelerated speed from the curve and apply the Windows 11 normalization factor (3.5)
    // to preserve low-speed precision and prevent excessive jumpiness.
    const accelSpeed = this.interpolateY(speed) / 3.5;

    // The ratio of acceleration
    const ratio = (accelSpeed / speed) * this.sensitivityMult * this.accelScale;

    return {
      dx: dx * ratio,
      dy: dy * ratio,
    };
  }
}
