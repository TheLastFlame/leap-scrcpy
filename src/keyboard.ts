
// HID Keyboard implementation for UHID
export class HidKeyboard {
  static getDescriptor(): Uint8Array {
    return new Uint8Array([
      0x05, 0x01,       // Usage Page (Generic Desktop)
      0x09, 0x06,       // Usage (Keyboard)
      0xA1, 0x01,       // Collection (Application)
      0x05, 0x07,       //   Usage Page (Key Codes)
      0x19, 0xE0,       //   Usage Minimum (224)
      0x29, 0xE7,       //   Usage Maximum (231)
      0x15, 0x00,       //   Logical Minimum (0)
      0x25, 0x01,       //   Logical Maximum (1)
      0x75, 0x01,       //   Report Size (1)
      0x95, 0x08,       //   Report Count (8)
      0x81, 0x02,       //   Input (Data, Variable, Absolute) ; Modifier byte
      
      0x75, 0x08,       //   Report Size (8)
      0x95, 0x01,       //   Report Count (1)
      0x81, 0x01,       //   Input (Constant) ; Reserved byte
      
      0x05, 0x08,       //   Usage Page (LEDs)
      0x19, 0x01,       //   Usage Minimum (1)
      0x29, 0x05,       //   Usage Maximum (5)
      0x75, 0x01,       //   Report Size (1)
      0x95, 0x05,       //   Report Count (5)
      0x91, 0x02,       //   Output (Data, Variable, Absolute) ; LED report
      0x95, 0x01,       //   Report Count (1)
      0x75, 0x03,       //   Report Size (3)
      0x91, 0x01,       //   Output (Constant) ; LED report padding
      
      0x05, 0x07,       //   Usage Page (Key Codes)
      0x19, 0x00,       //   Usage Minimum (0)
      0x29, 0xFF,       //   Usage Maximum (255)
      0x15, 0x00,       //   Logical Minimum (0)
      0x25, 0xFF,       //   Logical Maximum (255)
      0x75, 0x08,       //   Report Size (8)
      0x95, 0x06,       //   Report Count (6)
      0x81, 0x00,       //   Input (Data, Array) ; Keys
      0xC0              // End Collection
    ]);
  }

  #report = new Uint8Array(8);
  #pressedKeys = new Set<number>();
  #modifiers = 0;

  get report() {
    return this.#report;
  }

  // Synergy mask to HID modifiers
  static readonly SYNERGY_MOD_SHIFT = 0x0001;
  static readonly SYNERGY_MOD_CTRL = 0x0002;
  static readonly SYNERGY_MOD_ALT = 0x0004;
  static readonly SYNERGY_MOD_META = 0x0008;

  static readonly HID_MOD_LCTRL = 1 << 0;
  static readonly HID_MOD_LSHIFT = 1 << 1;
  static readonly HID_MOD_LALT = 1 << 2;
  static readonly HID_MOD_LMETA = 1 << 3;
  static readonly HID_MOD_RCTRL = 1 << 4;
  static readonly HID_MOD_RSHIFT = 1 << 5;
  static readonly HID_MOD_RALT = 1 << 6;
  static readonly HID_MOD_RMETA = 1 << 7;

  // Mapping from Windows Scan Code (Set 1) to USB HID Usage ID
  // Note: Synergy 'button' field on Windows contains these codes.
  // Some codes are prefixed with 0xE0 in Windows, but Synergy might send them differently.
  // We'll handle the most common ones.
  static windowsScanCodeToHid(scanCode: number): number {
    const mapping: Record<number, number> = {
      0x01: 0x29, // Escape
      0x02: 0x1e, // 1
      0x03: 0x1f, // 2
      0x04: 0x20, // 3
      0x05: 0x21, // 4
      0x06: 0x22, // 5
      0x07: 0x23, // 6
      0x08: 0x24, // 7
      0x09: 0x25, // 8
      0x0a: 0x26, // 9
      0x0b: 0x27, // 0
      0x0c: 0x2d, // -
      0x0d: 0x2e, // =
      0x0e: 0x2a, // Backspace
      0x0f: 0x2b, // Tab
      0x10: 0x14, // Q
      0x11: 0x1a, // W
      0x12: 0x08, // E
      0x13: 0x15, // R
      0x14: 0x17, // T
      0x15: 0x1c, // Y
      0x16: 0x18, // U
      0x17: 0x0c, // I
      0x18: 0x12, // O
      0x19: 0x13, // P
      0x1a: 0x2f, // [
      0x1b: 0x30, // ]
      0x1c: 0x28, // Enter
      0x1d: 0xe0, // Left Ctrl
      0x1e: 0x04, // A
      0x1f: 0x16, // S
      0x20: 0x07, // D
      0x21: 0x09, // F
      0x22: 0x0a, // G
      0x23: 0x0b, // H
      0x24: 0x0d, // J
      0x25: 0x0e, // K
      0x26: 0x0f, // L
      0x27: 0x33, // ;
      0x28: 0x34, // '
      0x29: 0x35, // `
      0x2a: 0xe1, // Left Shift
      0x2b: 0x31, // \
      0x2c: 0x1d, // Z
      0x2d: 0x1b, // X
      0x2e: 0x06, // C
      0x2f: 0x19, // V
      0x30: 0x05, // B
      0x31: 0x11, // N
      0x32: 0x10, // M
      0x33: 0x36, // ,
      0x34: 0x37, // .
      0x35: 0x38, // /
      0x36: 0xe5, // Right Shift
      0x37: 0x55, // KP *
      0x38: 0xe2, // Left Alt
      0x39: 0x2c, // Space
      0x3a: 0x39, // Caps Lock
      0x3b: 0x3a, // F1
      0x3c: 0x3b, // F2
      0x3d: 0x3c, // F3
      0x3e: 0x3d, // F4
      0x3f: 0x3e, // F5
      0x40: 0x3f, // F6
      0x41: 0x40, // F7
      0x42: 0x41, // F8
      0x43: 0x42, // F9
      0x44: 0x43, // F10
      0x45: 0x53, // Num Lock
      0x46: 0x47, // Scroll Lock
      0x47: 0x5f, // KP 7
      0x48: 0x60, // KP 8
      0x49: 0x61, // KP 9
      0x4a: 0x56, // KP -
      0x4b: 0x5c, // KP 4
      0x4c: 0x5d, // KP 5
      0x4d: 0x5e, // KP 6
      0x4e: 0x57, // KP +
      0x4f: 0x59, // KP 1
      0x50: 0x5a, // KP 2
      0x51: 0x5b, // KP 3
      0x52: 0x62, // KP 0
      0x53: 0x63, // KP .
      0x57: 0x44, // F11
      0x58: 0x45, // F12
      
      // Extended keys (prefixed with 0xE0 in Windows, but Synergy might send them as 0x1xx or similar)
      // Usually Synergy adds 0x100 or 0xE000. Let's handle both common cases.
      0xe01c: 0x58, // KP Enter
      0xe01d: 0xe4, // Right Ctrl
      0xe035: 0x54, // KP /
      0xe037: 0x46, // Print Screen
      0xe038: 0xe6, // Right Alt
      0xe047: 0x4a, // Home
      0xe048: 0x52, // Up
      0xe049: 0x4b, // Page Up
      0xe04b: 0x50, // Left
      0xe04d: 0x4f, // Right
      0xe04f: 0x4d, // End
      0xe050: 0x51, // Down
      0xe051: 0x4e, // Page Down
      0xe052: 0x49, // Insert
      0xe053: 0x4c, // Delete
      0xe05b: 0xe3, // Left GUI
      0xe05c: 0xe7, // Right GUI
      0xe05d: 0x65, // Application (Menu)
    };

    // If it's a "button" from Synergy, it might have 0x100 added for extended keys
    let effectiveCode = scanCode;
    if (scanCode > 0xff && (scanCode & 0xff00) === 0x100) {
        effectiveCode = 0xe000 | (scanCode & 0xff);
    }

    return mapping[effectiveCode] ?? mapping[scanCode] ?? 0;
  }

  #updateReport() {
    this.#report[0] = this.#modifiers;
    this.#report[1] = 0; // Reserved
    
    const keys = Array.from(this.#pressedKeys).slice(0, 6);
    for (let i = 0; i < 6; i++) {
      this.#report[2 + i] = i < keys.length ? keys[i] : 0;
    }
  }

  setModifiers(synergyMask: number) {
    let hidMods = 0;
    if (synergyMask & HidKeyboard.SYNERGY_MOD_SHIFT) hidMods |= HidKeyboard.HID_MOD_LSHIFT;
    if (synergyMask & HidKeyboard.SYNERGY_MOD_CTRL) hidMods |= HidKeyboard.HID_MOD_LCTRL;
    if (synergyMask & HidKeyboard.SYNERGY_MOD_ALT) hidMods |= HidKeyboard.HID_MOD_LALT;
    if (synergyMask & HidKeyboard.SYNERGY_MOD_META) hidMods |= HidKeyboard.HID_MOD_LMETA;
    this.#modifiers = hidMods;
    this.#updateReport();
  }

  keyDown(hidScancode: number) {
    if (hidScancode >= 0xE0 && hidScancode <= 0xE7) {
      // It's a modifier key scancode in HID
      this.#modifiers |= (1 << (hidScancode - 0xE0));
    } else {
      this.#pressedKeys.add(hidScancode);
    }
    this.#updateReport();
  }

  keyUp(hidScancode: number) {
    if (hidScancode >= 0xE0 && hidScancode <= 0xE7) {
      // It's a modifier key scancode in HID
      this.#modifiers &= ~(1 << (hidScancode - 0xE0));
    } else {
      this.#pressedKeys.delete(hidScancode);
    }
    this.#updateReport();
  }
}
