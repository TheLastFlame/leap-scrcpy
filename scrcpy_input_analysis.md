# Анализ захвата и передачи событий ввода в scrcpy

> **Источники:** `scrcpy_src/app/src/`  
> Версия scrcpy в репозитории: **4.x** (поддержка SDL3)

---

## Содержание

1. [Общая архитектура](#1-общая-архитектура)
2. [Уровень 1 — SDL-события (сырой ввод)](#2-уровень-1--sdl-события-сырой-ввод)
3. [Уровень 2 — scrcpy input events (промежуточный)](#3-уровень-2--scrcpy-input-events-промежуточный)
4. [sc_input_manager — главный диспетчер событий](#4-sc_input_manager--главный-диспетчер-событий)
5. [Мышь: клики, движение, ховер, скролл](#5-мышь-клики-движение-ховер-скролл)
6. [Тач (пальцы / тачпад)](#6-тач-пальцы--тачпад)
7. [Клавиатура и текстовый ввод](#7-клавиатура-и-текстовый-ввод)
8. [Геймпад / джойстик](#8-геймпад--джойстик)
9. [Симуляция виртуального пальца (pinch-to-zoom)](#9-симуляция-виртуального-пальца-pinch-to-zoom)
10. [Уровень 3 — процессоры (SDK vs HID)](#10-уровень-3--процессоры-sdk-vs-hid)
11. [Control Message — структуры и сериализация](#11-control-message--структуры-и-сериализация)
12. [Controller — очередь и транспорт](#12-controller--очередь-и-транспорт)
13. [HID-режим мыши](#13-hid-режим-мыши)
14. [Mouse Capture (относительный режим)](#14-mouse-capture-относительный-режим)
15. [Системы управления устройством (не-ввод)](#15-системы-управления-устройством-не-ввод)
16. [Бинарный протокол — полная таблица сообщений](#16-бинарный-протокол--полная-таблица-сообщений)
17. [Полная схема потока данных](#17-полная-схема-потока-данных)

---

## 1. Общая архитектура

Scrcpy обрабатывает ввод на **трёх уровнях**, последовательно преобразуя события:

```
┌─────────────────────────────────────────────────────────┐
│  Уровень 1: SDL3 Events                                 │
│  SDL_MouseMotionEvent, SDL_KeyboardEvent, ...           │
└────────────────────┬────────────────────────────────────┘
                     │  sc_input_manager_handle_event()
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Уровень 2: scrcpy input events                         │
│  sc_mouse_motion_event, sc_key_event, sc_touch_event,  │
│  sc_mouse_click_event, sc_mouse_scroll_event, ...       │
│  (координаты уже в device frame, не в window coords)   │
└────────────────────┬────────────────────────────────────┘
                     │  processor->ops->process_*()
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Уровень 3: Android / HID events                        │
│  sc_control_msg  ──► сериализация ──► TCP сокет         │
│  (SDK режим: inject touch/keycode)                      │
│  (HID режим: UHID_INPUT через AOA/USB)                  │
└─────────────────────────────────────────────────────────┘
```

**Ключевое отличие уровней 1→2:** SDL даёт координаты в пикселях окна (с учётом масштаба, рамок, поворота). scrcpy events — уже в координатах экрана устройства. Преобразование делает `sc_screen_convert_window_to_frame_coords()`.

---

## 2. Уровень 1 — SDL-события (сырой ввод)

Файл: [`input_manager.c:1168`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/input_manager.c#L1168-L1212)

Главная точка входа — `sc_input_manager_handle_event()`. Она разбирает **все** SDL3 события одним switch:

```c
void sc_input_manager_handle_event(struct sc_input_manager *im,
                                   const SDL_Event *event) {
    switch (event->type) {
        case SDL_EVENT_TEXT_INPUT:        // текстовый ввод (Unicode)
        case SDL_EVENT_KEY_DOWN:
        case SDL_EVENT_KEY_UP:            // клавиши
        case SDL_EVENT_MOUSE_MOTION:      // движение мыши / ховер
        case SDL_EVENT_MOUSE_WHEEL:       // колёсико / скролл тачпада
        case SDL_EVENT_MOUSE_BUTTON_DOWN:
        case SDL_EVENT_MOUSE_BUTTON_UP:   // кнопки мыши
        case SDL_EVENT_FINGER_MOTION:
        case SDL_EVENT_FINGER_DOWN:
        case SDL_EVENT_FINGER_UP:         // реальные touch-события (тачскрин/тачпад)
        case SDL_EVENT_GAMEPAD_ADDED:
        case SDL_EVENT_GAMEPAD_REMOVED:   // подключение/отключение геймпада
        case SDL_EVENT_GAMEPAD_AXIS_MOTION: // оси геймпада
        case SDL_EVENT_GAMEPAD_BUTTON_DOWN:
        case SDL_EVENT_GAMEPAD_BUTTON_UP: // кнопки геймпада
        case SDL_EVENT_DROP_FILE:         // drag-and-drop файла (APK или push)
        case SC_EVENT_DEVICE_DISCONNECTED:// внутреннее событие отключения
    }
}
```

### Важные фильтры на этом уровне

- **`event->which == SDL_TOUCH_MOUSEID`** — SDL3 автоматически генерирует фейковые мышиные события из touch. scrcpy **отбрасывает** их (строки 755, 848), чтобы не дублировать.
- **`im->disconnected`** — после дисконнекта все события (кроме некоторых шорткатов) игнорируются.
- **`im->screen->paused`** — в паузе большинство событий ввода блокируется.

---

## 3. Уровень 2 — scrcpy input events (промежуточный)

Файл: [`input_events.h`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/input_events.h)

Собственный слой абстракции, независимый от SDL. Все координаты — в **device frame**.

### Структуры событий

#### Клавиатура
```c
struct sc_key_event {
    enum sc_action action;      // SC_ACTION_DOWN / SC_ACTION_UP
    enum sc_keycode keycode;    // символьный код (SDLK_* -> SC_KEYCODE_*)
    enum sc_scancode scancode;  // физическая позиция клавиши
    uint16_t mods_state;        // битовая маска: Ctrl, Shift, Alt, GUI, NumLock, CapsLock
    bool repeat;                // авто-повтор при удержании
};

struct sc_text_event {
    const char *text;           // UTF-8 строка (не owned)
};
```

#### Мышь — движение
```c
struct sc_mouse_motion_event {
    struct sc_position position; // абсолютная позиция в device frame
    uint64_t pointer_id;         // SC_POINTER_ID_MOUSE или SC_POINTER_ID_GENERIC_FINGER
    int32_t xrel;                // относительное смещение X (для HID/relative mode)
    int32_t yrel;                // относительное смещение Y
    uint8_t buttons_state;       // битовая маска зажатых кнопок
};
```

#### Мышь — клик
```c
struct sc_mouse_click_event {
    struct sc_position position;
    enum sc_action action;        // DOWN / UP
    enum sc_mouse_button button;  // LEFT(1), RIGHT(2), MIDDLE(4), X1(8), X2(16)
    uint64_t pointer_id;
    uint8_t buttons_state;        // состояние ВСЕХ кнопок после этого события
};
```

#### Мышь — скролл
```c
struct sc_mouse_scroll_event {
    struct sc_position position;
    float hscroll;               // горизонтальный скролл (диапазон [-16, 16])
    float vscroll;               // вертикальный скролл
    uint8_t buttons_state;
};
```

#### Touch
```c
struct sc_touch_event {
    struct sc_position position;
    enum sc_touch_action action; // SC_TOUCH_ACTION_MOVE / DOWN / UP
    uint64_t pointer_id;         // уникальный ID пальца (fingerID из SDL)
    float pressure;              // давление [0.0, 1.0]
};
```

#### Геймпад
```c
struct sc_gamepad_device_event { uint32_t gamepad_id; };

struct sc_gamepad_button_event {
    uint32_t gamepad_id;
    enum sc_action action;
    enum sc_gamepad_button button; // SOUTH/EAST/WEST/NORTH/BACK/GUIDE/START/
                                   // LEFT_STICK/RIGHT_STICK/L1/R1/DPAD_*
};

struct sc_gamepad_axis_event {
    uint32_t gamepad_id;
    enum sc_gamepad_axis axis;  // LEFTX/LEFTY/RIGHTX/RIGHTY/L_TRIGGER/R_TRIGGER
    int16_t value;              // [-32768, 32767]
};
```

### Тип `sc_position` — система координат
```c
struct sc_position {
    struct sc_size screen_size; // размер экрана устройства (width, height) — uint16_t
    struct sc_point point;      // абсолютная точка — int32_t x, y
};
```

`screen_size` передаётся вместе с координатами, чтобы сервер мог нормализовать точку под реальное разрешение устройства (если оно отличается от frame size).

---

## 4. sc_input_manager — главный диспетчер событий

Файл: [`input_manager.h`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/input_manager.h), [`input_manager.c`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/input_manager.c)

### Структура

```c
struct sc_input_manager {
    struct sc_controller     *controller;  // очередь → сокет
    struct sc_file_pusher    *fp;          // drag-and-drop файлов
    struct sc_screen         *screen;      // размеры, текущий фрейм, пауза

    struct sc_key_processor  *kp;          // обработчик клавиатуры
    struct sc_mouse_processor *mp;         // обработчик мыши/тача
    struct sc_gamepad_processor *gp;       // обработчик геймпада

    bool camera;                           // режим камеры (другие шорткаты)

    struct sc_mouse_bindings mouse_bindings; // маппинг кнопок мыши
    bool legacy_paste;                     // старый режим вставки текстом
    bool clipboard_autosync;               // авто-синхронизация буфера обмена

    uint16_t sdl_shortcut_mods;            // битовая маска модификаторов шорткатов

    bool vfinger_down;                     // активен ли виртуальный палец
    bool vfinger_invert_x;                 // инверсия X для vfinger
    bool vfinger_invert_y;                 // инверсия Y для vfinger

    uint8_t mouse_buttons_state;           // текущее состояние всех кнопок мыши

    unsigned key_repeat;                   // счётчик повторов шортката
    SDL_Keycode last_keycode;
    uint16_t last_mod;

    uint64_t next_sequence;                // для подтверждения буфера обмена
    bool disconnected;
};
```

### Привязки кнопок мыши (`mouse_bindings`)

Каждая кнопка (кроме левой) может быть привязана к:

| Привязка | Действие |
|---|---|
| `SC_MOUSE_BINDING_CLICK` | Передаётся как клик устройству |
| `SC_MOUSE_BINDING_BACK` | → `press_back_or_turn_screen_on()` |
| `SC_MOUSE_BINDING_HOME` | → `action_home()` |
| `SC_MOUSE_BINDING_APP_SWITCH` | → `action_app_switch()` |
| `SC_MOUSE_BINDING_EXPAND_NOTIFICATION_PANEL` | → открыть шторку |
| `SC_MOUSE_BINDING_DISABLED` | событие игнорируется |

Два набора привязок: `pri` (без Shift) и `sec` (с Shift).

---

## 5. Мышь: клики, движение, ховер, скролл

### 5.1 Движение мыши / Ховер

Функция: `sc_input_manager_process_mouse_motion()`  
Файл: [`input_manager.c:748`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/input_manager.c#L748-L785)

```c
static void
sc_input_manager_process_mouse_motion(struct sc_input_manager *im,
                                      const SDL_MouseMotionEvent *event) {
    // 1. Отбросить фейковые touch→mouse события
    if (event->which == SDL_TOUCH_MOUSEID) return;

    struct sc_mouse_motion_event evt = {
        // Конвертировать window coords → device frame coords
        .position   = sc_input_manager_get_position(im, event->x, event->y),
        // Если активен vfinger — pointer становится "generic finger", иначе "mouse"
        .pointer_id = im->vfinger_down ? SC_POINTER_ID_GENERIC_FINGER
                                       : SC_POINTER_ID_MOUSE,
        .xrel         = event->xrel,   // относительное смещение (для HID)
        .yrel         = event->yrel,
        .buttons_state = im->mouse_buttons_state,
    };

    im->mp->ops->process_mouse_motion(im->mp, &evt);

    // Если активен виртуальный палец — двигаем его симметрично
    if (im->vfinger_down) {
        struct sc_point vfinger = inverse_point(mouse, frame_size,
                                                im->vfinger_invert_x,
                                                im->vfinger_invert_y);
        simulate_virtual_finger(im, AMOTION_EVENT_ACTION_MOVE, vfinger);
    }
}
```

**Ховер** — движение без нажатых кнопок. На уровне SDK-процессора:
- Если `mouse_hover = true` и `buttons_state == 0` → шлёт `AMOTION_EVENT_ACTION_HOVER_MOVE`
- Если `mouse_hover = false` и нет нажатых кнопок → движение игнорируется

### 5.2 Клик мыши

Функция: `sc_input_manager_process_mouse_button()`  
Файл: [`input_manager.c:838`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/input_manager.c#L838-L1009)

**Порядок обработки:**
1. Отброс фейковых touch→mouse событий
2. Маппинг кнопки через `sc_input_manager_get_binding()` по таблице привязок
3. Особый случай: двойной клик за пределами видеорамки → `sc_screen_resize_to_fit()`
4. Обновление `mouse_buttons_state` (бит кнопки)
5. Формирование `sc_mouse_click_event`
6. Вызов `mp->ops->process_mouse_click()`
7. Если нужно — запуск/остановка виртуального пальца для pinch-to-zoom

### 5.3 Скролл / Колёсико

Функция: `sc_input_manager_process_mouse_wheel()`  
Файл: [`input_manager.c:1011`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/input_manager.c#L1011-L1037)

```c
// Получаем актуальную позицию курсора через SDL_GetMouseState()
float mouse_x, mouse_y;
SDL_GetMouseState(&mouse_x, &mouse_y);

struct sc_mouse_scroll_event evt = {
    .position      = sc_input_manager_get_position(im, mouse_x, mouse_y),
    .hscroll       = event->x,   // горизонтальный скролл (float)
    .vscroll       = event->y,   // вертикальный скролл (float)
    .buttons_state = im->mouse_buttons_state,
};

im->mp->ops->process_mouse_scroll(im->mp, &evt);
```

> Тачпад на macOS/Linux передаёт непрерывный скролл через `SDL_EVENT_MOUSE_WHEEL` — обрабатывается идентично колёсику.

### 5.4 Преобразование координат

```c
static struct sc_position
sc_input_manager_get_position(struct sc_input_manager *im,
                               int32_t x, int32_t y) {
    if (im->mp->relative_mode) {
        // В relative mode абсолютная позиция не нужна
        return (struct sc_position) { .screen_size = {0,0}, .point = {0,0} };
    }
    return (struct sc_position) {
        .screen_size = im->screen->frame_size,
        .point = sc_screen_convert_window_to_frame_coords(im->screen, x, y),
    };
}
```

`sc_screen_convert_window_to_frame_coords()` учитывает:
- Масштаб окна
- Чёрные рамки (letterbox/pillarbox)
- Поворот (orientation transform)

---

## 6. Тач (пальцы / тачпад)

Функция: `sc_input_manager_process_touch()`  
Файл: [`input_manager.c:787`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/input_manager.c#L787-L817)

SDL3 даёт touch-координаты **нормализованными** [0.0, 1.0]. scrcpy денормализует их:

```c
struct sc_size window_size = sc_sdl_get_window_size(im->screen->window);

// Денормализация: float → пиксели окна
int32_t x = event->x * (int32_t) window_size.width;
int32_t y = event->y * (int32_t) window_size.height;

struct sc_touch_event evt = {
    .position = {
        .screen_size = im->screen->frame_size,
        .point = sc_screen_convert_window_to_frame_coords(im->screen, x, y),
    },
    .action     = sc_touch_action_from_sdl(event->type), // MOVE/DOWN/UP
    .pointer_id = event->fingerID,   // уникальный ID пальца из SDL
    .pressure   = event->pressure,   // [0.0, 1.0]
};

im->mp->ops->process_touch(im->mp, &evt);
```

**Отображение SDL → Android actions:**

| SDL тип | sc_touch_action | Android action |
|---|---|---|
| `SDL_EVENT_FINGER_DOWN` | `SC_TOUCH_ACTION_DOWN` | `AMOTION_EVENT_ACTION_DOWN` |
| `SDL_EVENT_FINGER_MOTION` | `SC_TOUCH_ACTION_MOVE` | `AMOTION_EVENT_ACTION_MOVE` |
| `SDL_EVENT_FINGER_UP` | `SC_TOUCH_ACTION_UP` | `AMOTION_EVENT_ACTION_UP` |

---

## 7. Клавиатура и текстовый ввод

### 7.1 Обработка клавиш

Функция: `sc_input_manager_process_key()`  
Файл: [`input_manager.c:413`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/input_manager.c#L413-L729)

**Логика обработки:**

```
Пришёл SDL_EVENT_KEY_DOWN/UP
        │
        ├─ F11 без модификаторов → sc_screen_toggle_fullscreen() [локально]
        │
        ├─ Это shortcut (с MOD-клавишей)?
        │   ├─ Локальные шорткаты (не требуют соединения):
        │   │   MOD+Z/F/W/G/I/Q/Left/Right/Up/Down → UI-действия
        │   │
        │   └─ Шорткаты устройства (требуют controller):
        │       MOD+H → Home, MOD+B → Back, MOD+S → AppSwitch
        │       MOD+M → Menu, MOD+P → Power, MOD+O → Display power
        │       MOD+↑/↓ → Volume, MOD+C/X → Copy/Cut clipboard
        │       MOD+V → Paste, MOD+N → Notification panel
        │       MOD+R → Rotate, MOD+K → HID keyboard settings
        │
        └─ Обычная клавиша → sc_key_event → kp->ops->process_key()
```

**Три режима инъекции клавиш** (настраивается `--keyboard-input-mode`):
- `SC_KEY_INJECT_MODE_TEXT` — буквы/пробел как text events, остальное как keycode
- `SC_KEY_INJECT_MODE_RAW` — всё как keycode (включая цифры и пунктуацию)
- `SC_KEY_INJECT_MODE_MIXED` — буквы/пробел как keycode, остальное как text

### 7.2 Текстовый ввод

Функция: `sc_input_manager_process_text_input()`

```c
// SDL_EVENT_TEXT_INPUT: UTF-8 строка от ОС (IME, compose, etc.)
struct sc_text_event evt = { .text = event->text };
im->kp->ops->process_text(im->kp, &evt);
```

Блокируется если активен shortcut-модификатор (чтобы `MOD+v` не генерировал символ `v`).

### 7.3 SDK-клавиатура: конвертация кодов

Файл: [`keyboard_sdk.c`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/keyboard_sdk.c)

```c
// SC_KEYCODE_* → AKEYCODE_* (Android keycodes)
// Три таблицы:
// 1. special_keys[] — навигация, Enter, Escape, модификаторы
// 2. kp_nav_keys[] — numpad без NumLock
// 3. alphaspace_keys[] — буквы A-Z и пробел
// 4. numbers_punct_keys[] — только для RAW режима

// Метасостояние: побитовое OR всех modifier-флагов Android
enum android_metastate = convert_meta_state(sc_key_event.mods_state);
```

---

## 8. Геймпад / джойстик

Файлы: [`input_manager.c:1039`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/input_manager.c#L1039-L1124), [`trait/gamepad_processor.h`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/trait/gamepad_processor.h)

### Подключение/отключение
```c
// SDL_EVENT_GAMEPAD_ADDED:
SDL_Gamepad *sdl_gamepad = SDL_OpenGamepad(event->which);
SDL_Joystick *joystick = SDL_GetGamepadJoystick(sdl_gamepad);
uint32_t gamepad_id = SDL_GetJoystickID(joystick);
gp->ops->process_gamepad_added(gp, &evt);

// SDL_EVENT_GAMEPAD_REMOVED:
SDL_CloseGamepad(sdl_gamepad);
gp->ops->process_gamepad_removed(gp, &evt);
```

### Оси (аналоговые стики, триггеры)
```c
// SDL_EVENT_GAMEPAD_AXIS_MOTION
struct sc_gamepad_axis_event {
    .gamepad_id = event->which,
    .axis  = sc_gamepad_axis_from_sdl(event->axis),
    .value = event->value,   // int16_t: [-32768, 32767]
};
```

Поддерживаемые оси:
| SDL | scrcpy |
|---|---|
| `SDL_GAMEPAD_AXIS_LEFTX` | `SC_GAMEPAD_AXIS_LEFTX` |
| `SDL_GAMEPAD_AXIS_LEFTY` | `SC_GAMEPAD_AXIS_LEFTY` |
| `SDL_GAMEPAD_AXIS_RIGHTX` | `SC_GAMEPAD_AXIS_RIGHTX` |
| `SDL_GAMEPAD_AXIS_RIGHTY` | `SC_GAMEPAD_AXIS_RIGHTY` |
| `SDL_GAMEPAD_AXIS_LEFT_TRIGGER` | `SC_GAMEPAD_AXIS_LEFT_TRIGGER` |
| `SDL_GAMEPAD_AXIS_RIGHT_TRIGGER` | `SC_GAMEPAD_AXIS_RIGHT_TRIGGER` |

### Кнопки геймпада
```c
// SDL_EVENT_GAMEPAD_BUTTON_DOWN/UP
struct sc_gamepad_button_event {
    .gamepad_id = event->which,
    .action = sc_action_from_sdl_gamepad_button_type(event->type), // DOWN/UP
    .button = sc_gamepad_button_from_sdl(event->button),
};
```

Поддерживаемые кнопки: SOUTH, EAST, WEST, NORTH, BACK, GUIDE, START, LEFT_STICK, RIGHT_STICK, L1, R1, DPAD_UP, DPAD_DOWN, DPAD_LEFT, DPAD_RIGHT.

---

## 9. Симуляция виртуального пальца (pinch-to-zoom)

Файл: [`input_manager.c:377`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/input_manager.c#L377-L411)

При зажатом **Ctrl или Shift** во время клика левой кнопкой мыши — активируется **виртуальный второй палец**. Его позиция симметрична реальному курсору относительно центра экрана.

```
Ctrl pressed + LMB down:
  vfinger_invert_x = true   (Ctrl ^ Shift = 1 ^ 0 = 1)
  vfinger_invert_y = true   (Ctrl = 1)
  → Вращение / масштабирование (pinch-to-zoom)

Shift pressed + LMB down:
  vfinger_invert_x = true   (0 ^ 1 = 1)
  vfinger_invert_y = false  (Shift = 0)
  → Вертикальный наклон (два пальца скользят вверх/вниз)

Ctrl+Shift + LMB down:
  vfinger_invert_x = false  (1 ^ 1 = 0)
  vfinger_invert_y = true   (1)
  → Горизонтальный наклон
```

Виртуальный палец:
- Получает `pointer_id = SC_POINTER_ID_VIRTUAL_FINGER` (= `UINT64_C(-3)`)
- `pressure = 1.0` при down/move, `0.0` при up
- Передаётся напрямую через `sc_controller_push_msg()`, минуя mouse_processor

---

## 10. Уровень 3 — процессоры (SDK vs HID)

### Trait-интерфейсы

**`sc_mouse_processor`** [`trait/mouse_processor.h`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/trait/mouse_processor.h):
```c
struct sc_mouse_processor_ops {
    void (*process_mouse_motion)(mp, event);  // обязателен
    void (*process_mouse_click)(mp, event);   // обязателен
    void (*process_mouse_scroll)(mp, event);  // опционален
    void (*process_touch)(mp, event);         // опционален
};
```

**`sc_key_processor`** [`trait/key_processor.h`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/trait/key_processor.h):
```c
struct sc_key_processor_ops {
    void (*process_key)(kp, event, ack_to_wait);  // обязателен
    void (*process_text)(kp, event);              // опционален
};
```

**`sc_gamepad_processor`** [`trait/gamepad_processor.h`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/trait/gamepad_processor.h):
```c
struct sc_gamepad_processor_ops {
    void (*process_gamepad_added)(gp, event);    // обязателен
    void (*process_gamepad_removed)(gp, event);  // обязателен
    void (*process_gamepad_axis)(gp, event);     // обязателен
    void (*process_gamepad_button)(gp, event);   // обязателен
};
```

### Два режима передачи

| Режим | Реализация | Транспорт |
|---|---|---|
| **SDK** | `sc_mouse_sdk`, `sc_keyboard_sdk` | `INJECT_TOUCH_EVENT` / `INJECT_KEYCODE` через TCP |
| **HID** | `hid_mouse`, `hid_keyboard`, `hid_gamepad` | `UHID_CREATE` + `UHID_INPUT` через TCP, затем AOA/USB |

**SDK режим** — устройство принимает высокоуровневые Android события.  
**HID режим** — устройство видит виртуальный USB HID-девайс (мышь, клавиатура, геймпад).

---

## 11. Control Message — структуры и сериализация

Файл: [`control_msg.h`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/control_msg.h), [`control_msg.c`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/control_msg.c)

### Специальные pointer_id

```c
#define SC_POINTER_ID_MOUSE          UINT64_C(-1)  // 0xFFFFFFFFFFFFFFFF
#define SC_POINTER_ID_GENERIC_FINGER UINT64_C(-2)  // используется при vfinger_down
#define SC_POINTER_ID_VIRTUAL_FINGER UINT64_C(-3)  // второй палец pinch-to-zoom
```

### SDK Mouse → Control Message

В `mouse_sdk.c` — преобразование scrcpy events в control messages:

```c
// Движение мыши
.action = buttons_state ? AMOTION_EVENT_ACTION_MOVE
                        : AMOTION_EVENT_ACTION_HOVER_MOVE,

// Клик
.action = AMOTION_EVENT_ACTION_DOWN / UP,
.pressure = action == DOWN ? 1.0f : 0.0f,
.action_button = convert_mouse_buttons(event->button),  // какая кнопка
.buttons = convert_mouse_buttons(event->buttons_state), // все зажатые

// Скролл → SC_CONTROL_MSG_TYPE_INJECT_SCROLL_EVENT (отдельный тип!)
```

**Маппинг кнопок мыши → Android:**

| SC_MOUSE_BUTTON | Android |
|---|---|
| LEFT | `AMOTION_EVENT_BUTTON_PRIMARY` |
| RIGHT | `AMOTION_EVENT_BUTTON_SECONDARY` |
| MIDDLE | `AMOTION_EVENT_BUTTON_TERTIARY` |
| X1 | `AMOTION_EVENT_BUTTON_BACK` |
| X2 | `AMOTION_EVENT_BUTTON_FORWARD` |

---

## 12. Controller — очередь и транспорт

Файл: [`controller.h`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/controller.h), [`controller.c`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/controller.c)

```c
struct sc_controller {
    sc_socket control_socket;          // TCP сокет к scrcpy-серверу на устройстве
    sc_thread thread;                  // отдельный поток записи
    sc_mutex mutex;
    sc_cond msg_cond;
    bool stopped;
    struct sc_control_msg_queue queue; // динамический deque (vecdeque)
    struct { uint16_t width, height; } resize_display; // приоритетное сообщение
    struct sc_receiver receiver;       // поток чтения (clipboard sync, acks)
};
```

### Поток данных

```
process_*() → sc_controller_push_msg()
                    │
                    ▼
            [mutex_lock]
            queue.push(msg)         // лимит 60 сообщений
            if was_empty: cond_signal
            [mutex_unlock]
                    │
         ┌──────────▼──────────┐
         │  run_controller()   │   // отдельный поток "scrcpy-ctl"
         │  (ожидает cond)     │
         └──────────┬──────────┘
                    │ sc_control_msg_serialize()
                    ▼
            net_send_all(control_socket, buf, len)
```

### Управление очередью

```c
#define SC_CONTROL_MSG_QUEUE_LIMIT 60

// Если очередь переполнена:
// - droppable события (motion, scroll) → отбрасываются
// - non-droppable (UHID_CREATE, UHID_DESTROY) → принудительно добавляются

bool sc_control_msg_is_droppable(msg):
    return msg->type != UHID_CREATE && msg->type != UHID_DESTROY;
```

### RESIZE_DISPLAY — приоритетное сообщение

Не попадает в общую очередь — хранится в отдельном поле `resize_display`. Новый запрос перезаписывает предыдущий. Обрабатывается первым при наличии.

---

## 13. HID-режим мыши

Файл: [`hid/hid_mouse.c`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/hid/hid_mouse.c)

В HID-режиме мышь передаётся как **USB HID-устройство** через UHID.

### HID Report (5 байт)

```
byte 0: кнопки (битовая маска)
        bit 0 → левая кнопка
        bit 1 → правая кнопка
        bit 2 → средняя кнопка
        bit 3 → кнопка 4 (X1/Back)
        bit 4 → кнопка 5 (X2/Forward)
        bits 5-7 → padding

byte 1: xrel — относительное смещение X (int8, [-127, 127])
byte 2: yrel — относительное смещение Y (int8, [-127, 127])
byte 3: vscroll — вертикальный скролл (int8)
byte 4: hscroll — горизонтальный скролл (int8, AC Pan)
```

### Особенность скролла в HID

HID передаёт только целочисленные значения. Дробные накапливаются:
```c
hid->residual_hscroll += event->hscroll;
hid->residual_vscroll += event->vscroll;
// Отправить только целую часть, сохранить остаток
int8_t vscroll = consume_scroll_integer(&hid->residual_vscroll);
```

### HID Report Descriptor

Следует спецификации USB HID §E.10 (Appendix E, Mouse example). Включает:
- Generic Desktop, Mouse, Pointer коллекции
- 5 кнопок + 3 padding бита
- X, Y, Wheel оси (Relative, -127..127)
- AC Pan для горизонтального скролла

---

## 14. Mouse Capture (относительный режим)

Файл: [`mouse_capture.c`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/mouse_capture.c)

Используется в HID-режиме. Мышь "захватывается" окном — курсор скрывается и SDL отдаёт только относительные смещения.

### Механизм захвата

```c
// Активация: SDL_SetWindowRelativeMouseMode(window, true)
// Деактивация: SDL_SetWindowRelativeMouseMode(window, false)

// Триггеры:
// - SDL_EVENT_KEY_DOWN/UP: нажатие/отпускание shortcut-клавиши переключает режим
// - SDL_EVENT_WINDOW_FOCUS_LOST: автоматически деактивирует захват

// Пока захват не активен:
// - MOUSE_MOTION, WHEEL, BUTTON_DOWN → отбрасываются (возвращают true)
// - BUTTON_UP → активирует захват (click to capture)
```

Touch-события (`FINGER_*`) в relative mode всегда отбрасываются — они несовместимы (абсолютные координаты не имеют смысла в режиме захвата).

---

## 15. Системы управления устройством (не-ввод)

Помимо ввода, через тот же канал идут команды управления:

| Тип сообщения | Триггер | Описание |
|---|---|---|
| `BACK_OR_SCREEN_ON` | MOD+B / MOD+BACKSPACE | Назад или включение экрана |
| `EXPAND_NOTIFICATION_PANEL` | MOD+N | Открыть шторку уведомлений |
| `EXPAND_SETTINGS_PANEL` | MOD+N+N (двойной) | Открыть быстрые настройки |
| `COLLAPSE_PANELS` | MOD+Shift+N | Закрыть шторку |
| `GET_CLIPBOARD` | MOD+C / MOD+X | Скопировать/вырезать из устройства |
| `SET_CLIPBOARD` | MOD+V / автосинхр. | Вставить в буфер устройства |
| `SET_DISPLAY_POWER` | MOD+O / MOD+Shift+O | Вкл/выкл экран |
| `ROTATE_DEVICE` | MOD+R | Повернуть экран |
| `UHID_CREATE` | Инициализация HID | Создать виртуальный HID-девайс |
| `UHID_INPUT` | Любой HID-ввод | Данные HID-репорта |
| `UHID_DESTROY` | Выключение HID | Удалить HID-девайс |
| `OPEN_HARD_KEYBOARD_SETTINGS` | MOD+K (только HID) | Открыть настройки клавиатуры |
| `START_APP` | — | Запустить приложение |
| `RESET_VIDEO` | MOD+Shift+R | Сбросить видеопоток |
| `CAMERA_SET_TORCH` | MOD+T (camera mode) | Вкл/выкл фонарик |
| `CAMERA_ZOOM_IN/OUT` | MOD+↑/↓ (camera mode) | Зум камеры |
| `RESIZE_DISPLAY` | Resize окна | Изменить разрешение трансляции |

---

## 16. Бинарный протокол — полная таблица сообщений

Файл: [`control_msg.c:103`](file:///D:/tl_scrcpy_client/scrcpy_src/app/src/control_msg.c#L103-L206)

Все сообщения — **big-endian**. Первый байт всегда тип.

### INJECT_KEYCODE (тип 0x00) — 14 байт

```
[0]     type = 0x00
[1]     action (0=DOWN, 1=UP, 2=MULTIPLE)
[2..5]  keycode (uint32, Android AKEYCODE_*)
[6..9]  repeat (uint32)
[10..13] metastate (uint32, Android AMETA_* битовая маска)
```

### INJECT_TEXT (тип 0x01) — переменная длина

```
[0]    type = 0x01
[1..4] string_len (uint32)
[5..]  UTF-8 строка (макс. 300 байт)
```

### INJECT_TOUCH_EVENT (тип 0x02) — 32 байта

```
[0]     type = 0x02
[1]     action (AMOTION_EVENT_ACTION_*)
[2..9]  pointer_id (uint64, BE)
[10..13] x (int32, в device pixels)
[14..17] y (int32)
[18..19] screen_width (uint16)
[20..21] screen_height (uint16)
[22..23] pressure (uint16, fixed point: value = pressure * 0xFFFF)
[24..27] action_button (uint32, AMOTION_EVENT_BUTTON_*)
[28..31] buttons (uint32, все зажатые кнопки)
```

### INJECT_SCROLL_EVENT (тип 0x03) — 21 байт

```
[0]     type = 0x03
[1..4]  x (int32)
[5..8]  y (int32)
[9..10] screen_width (uint16)
[11..12] screen_height (uint16)
[13..14] hscroll (int16, fixed point: val/16 нормализованный, затем i16fp)
[15..16] vscroll (int16)
[17..20] buttons (uint32)
```

> Скролл нормализуется: диапазон [-16, 16] → [-1, 1], затем кодируется в int16 fixed point.

### BACK_OR_SCREEN_ON (тип 0x04) — 2 байта

```
[0] type = 0x04
[1] action (0=DOWN, 1=UP)
```

### SET_CLIPBOARD (тип 0x09) — переменная

```
[0]    type = 0x09
[1..8] sequence (uint64) — для подтверждения (ack_to_wait)
[9]    paste flag (bool)
[10..13] string_len (uint32)
[14..] UTF-8 текст (макс. 256KB - 14)
```

### UHID_CREATE (тип 0x0C)

```
[0]    type = 0x0C
[1..2] hid_id (uint16)
[3..4] vendor_id (uint16)
[5..6] product_id (uint16)
[7]    name_len (uint8)
[8..8+name_len] name
[8+name_len .. +2] report_desc_size (uint16)
[...] report_descriptor bytes
```

### UHID_INPUT (тип 0x0D)

```
[0]    type = 0x0D
[1..2] hid_id (uint16)
[3..4] data_size (uint16)
[5..] HID report data (макс. SC_HID_MAX_SIZE байт)
```

Для мыши: 5 байт (кнопки + xrel + yrel + vscroll + hscroll).

---

## 17. Полная схема потока данных

### Мышь (SDK режим, движение)

```
Физическая мышь
    │ (ОС / SDL3)
    ▼
SDL_MouseMotionEvent { x, y, xrel, yrel, which }
    │ sc_input_manager_handle_event() → case SDL_EVENT_MOUSE_MOTION
    ▼
sc_input_manager_process_mouse_motion()
    │ SDL window coords → device frame coords
    │ sc_screen_convert_window_to_frame_coords()
    ▼
sc_mouse_motion_event {
    position: { screen_size: {W,H}, point: {x,y} },
    pointer_id: SC_POINTER_ID_MOUSE,
    xrel, yrel,
    buttons_state
}
    │ mp->ops->process_mouse_motion()
    ▼
sc_mouse_processor_process_mouse_motion() [mouse_sdk.c]
    │ buttons_state == 0 ? HOVER_MOVE : MOVE
    ▼
sc_control_msg {
    type: INJECT_TOUCH_EVENT,
    action: AMOTION_EVENT_ACTION_HOVER_MOVE / MOVE,
    pointer_id: SC_POINTER_ID_MOUSE,
    position: { x, y, W, H },
    pressure: 1.0,
    buttons: convert_mouse_buttons(buttons_state)
}
    │ sc_controller_push_msg()
    ▼
Controller queue (vecdeque, max 60)
    │ [run_controller thread]
    │ sc_control_msg_serialize() → 32 bytes big-endian
    ▼
net_send_all(control_socket, buf, 32)
    │ TCP / ADB tunnel
    ▼
scrcpy-server (Android)
    │ MotionEvent.inject()
    ▼
Android приложение получает MotionEvent
```

### Тач (HID режим, клик)

```
Тачпад / тачскрин
    │ (ОС / SDL3)
    ▼
SDL_TouchFingerEvent { fingerID, x, y, pressure, type }
    │ sc_input_manager_process_touch()
    │ float[0..1] → пиксели окна → device frame
    ▼
sc_touch_event { position, action=DOWN, pointer_id=fingerID, pressure }
    │ mp->ops->process_touch() [hid_mouse.c в HID режиме]
    ▼
HID report (5 байт):
    [0] buttons=0, [1] xrel=0, [2] yrel=0, [3] vscroll=0, [4] hscroll=0
    │ (для touch — только статус кнопок, движение относительное)
    ▼
sc_control_msg { type: UHID_INPUT, hid_id: SC_HID_ID_MOUSE, data[5] }
    │ sc_controller_push_msg()
    ▼
32-байтная сериализация → TCP → Android UHID → ядро Linux → /dev/uhid
```

---

## Итоговая таблица поддерживаемых событий

| Событие | SDL источник | Файл обработки | Android результат |
|---|---|---|---|
| Мышь: движение | `SDL_EVENT_MOUSE_MOTION` | `input_manager.c` → `mouse_sdk.c` | `AMOTION_EVENT_ACTION_MOVE` |
| Мышь: ховер | `SDL_EVENT_MOUSE_MOTION` (без кнопок) | `input_manager.c` → `mouse_sdk.c` | `AMOTION_EVENT_ACTION_HOVER_MOVE` |
| Мышь: клик | `SDL_EVENT_MOUSE_BUTTON_*` | `input_manager.c` → `mouse_sdk.c` | `AMOTION_EVENT_ACTION_DOWN/UP` |
| Мышь: скролл / тачпад | `SDL_EVENT_MOUSE_WHEEL` | `input_manager.c` → `mouse_sdk.c` | `INJECT_SCROLL_EVENT` |
| Touch: палец | `SDL_EVENT_FINGER_*` | `input_manager.c` → `mouse_sdk.c` | `AMOTION_EVENT_ACTION_DOWN/MOVE/UP` |
| Pinch-to-zoom | `SDL_EVENT_MOUSE_MOTION` + Ctrl/Shift | `input_manager.c` (vfinger) | два `INJECT_TOUCH_EVENT` параллельно |
| Клавиатура (keycode) | `SDL_EVENT_KEY_DOWN/UP` | `input_manager.c` → `keyboard_sdk.c` | `INJECT_KEYCODE` |
| Клавиатура (текст) | `SDL_EVENT_TEXT_INPUT` | `input_manager.c` → `keyboard_sdk.c` | `INJECT_TEXT` |
| Геймпад: ось | `SDL_EVENT_GAMEPAD_AXIS_MOTION` | `input_manager.c` → gamepad processor | UHID / SDK |
| Геймпад: кнопка | `SDL_EVENT_GAMEPAD_BUTTON_*` | `input_manager.c` → gamepad processor | UHID / SDK |
| HID мышь: движение | `MOUSE_MOTION` | `hid_mouse.c` | `UHID_INPUT` (xrel, yrel) |
| HID мышь: скролл | `MOUSE_WHEEL` | `hid_mouse.c` | `UHID_INPUT` (vscroll/hscroll, накопительный) |
| Drag-and-drop файла | `SDL_EVENT_DROP_FILE` | `input_manager.c` → `file_pusher` | ADB push / install APK |
