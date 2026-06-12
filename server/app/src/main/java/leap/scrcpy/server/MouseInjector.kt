package leap.scrcpy.server

import android.os.Build
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.MotionEvent.PointerCoords
import android.view.MotionEvent.PointerProperties

object MouseInjector {
    private val inputManagerInstance: Any by lazy {
        try {
            FakeContext.instance.getSystemService(android.content.Context.INPUT_SERVICE)!!
        } catch (e: Exception) {
            try {
                val inputManagerClass = Class.forName("android.hardware.input.InputManager")
                val getInstanceMethod = inputManagerClass.getDeclaredMethod("getInstance")
                getInstanceMethod.isAccessible = true
                getInstanceMethod.invoke(null)!!
            } catch (e2: Exception) {
                val inputManagerClass = Class.forName("android.hardware.input.InputManager")
                val getInstanceMethod = inputManagerClass.getMethod("getInstance")
                getInstanceMethod.invoke(null)!!
            }
        }
    }

    private val injectInputEventMethod by lazy {
        val inputManagerClass = inputManagerInstance.javaClass
        try {
            inputManagerClass.getMethod(
                "injectInputEvent",
                android.view.InputEvent::class.java,
                Int::class.javaPrimitiveType
            ).apply {
                isAccessible = true
            }
        } catch (e: Exception) {
            inputManagerClass.getDeclaredMethod(
                "injectInputEvent",
                android.view.InputEvent::class.java,
                Int::class.javaPrimitiveType
            ).apply {
                isAccessible = true
            }
        }
    }

    private var downTime: Long = 0
    private var activeSource = InputDevice.SOURCE_MOUSE
    private var activeTool = MotionEvent.TOOL_TYPE_MOUSE

    fun inject(action: Int, x: Float, y: Float, buttonState: Int, vscroll: Float, hscroll: Float) {
        android.util.Log.i("MouseInjector", "inject: action=$action, x=$x, y=$y, buttonState=$buttonState, vscroll=$vscroll, hscroll=$hscroll")
        val eventTime = SystemClock.uptimeMillis()
        if (action == MotionEvent.ACTION_DOWN) {
            downTime = eventTime

            val activeSecondaryButtons = (buttonState and 1.inv()) != 0
            if (activeSecondaryButtons) {
                activeSource = InputDevice.SOURCE_MOUSE
                activeTool = MotionEvent.TOOL_TYPE_MOUSE
            } else {
                activeSource = InputDevice.SOURCE_TOUCHSCREEN
                activeTool = MotionEvent.TOOL_TYPE_FINGER
            }
        } else if (downTime == 0L) {
            downTime = eventTime
        }

        val source: Int
        val tool: Int
        val finalButtonState: Int

        if (action == MotionEvent.ACTION_HOVER_MOVE || action == MotionEvent.ACTION_SCROLL) {
            tool = MotionEvent.TOOL_TYPE_MOUSE
            source = InputDevice.SOURCE_MOUSE
            finalButtonState = buttonState
        } else {
            tool = activeTool
            source = activeSource
            finalButtonState = if (source == InputDevice.SOURCE_TOUCHSCREEN) 0 else buttonState
        }

        val properties = arrayOf(PointerProperties().apply {
            id = 0
            toolType = tool
        })

        val coords = arrayOf(PointerCoords().apply {
            this.x = x
            this.y = y
            this.pressure = if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_HOVER_MOVE) 0.0f else 1.0f
            if (action == MotionEvent.ACTION_SCROLL) {
                setAxisValue(MotionEvent.AXIS_VSCROLL, vscroll)
                setAxisValue(MotionEvent.AXIS_HSCROLL, hscroll)
            }
        })

        // Match scrcpy's API 23+ mouse button event sequence:
        // Down / Up transitions with actionButton & buttonState
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && source == InputDevice.SOURCE_MOUSE) {
                if (action == MotionEvent.ACTION_DOWN) {
                    // 1. ACTION_DOWN
                    val downEvent = MotionEvent.obtain(
                        downTime, eventTime, MotionEvent.ACTION_DOWN, 1, properties, coords,
                        0, finalButtonState, 1.0f, 1.0f, 0, 0, source, 0
                    )
                    injectInputEventMethod.invoke(inputManagerInstance, downEvent, 0)
                    downEvent.recycle()

                    // 2. ACTION_BUTTON_PRESS
                    val pressEvent = MotionEvent.obtain(
                        downTime, eventTime, MotionEvent.ACTION_BUTTON_PRESS, 1, properties, coords,
                        0, finalButtonState, 1.0f, 1.0f, 0, 0, source, 0
                    )
                    // Set action button using reflection to match scrcpy's:
                    // pressEvent.setActionButton(buttonState)
                    try {
                        val setActionButtonMethod = MotionEvent::class.java.getMethod("setActionButton", Int::class.javaPrimitiveType)
                        setActionButtonMethod.invoke(pressEvent, finalButtonState)
                    } catch (e: Exception) {}
                    injectInputEventMethod.invoke(inputManagerInstance, pressEvent, 0)
                    pressEvent.recycle()
                    return
                }

                if (action == MotionEvent.ACTION_UP) {
                    // 1. ACTION_BUTTON_RELEASE
                    val releaseEvent = MotionEvent.obtain(
                        downTime, eventTime, MotionEvent.ACTION_BUTTON_RELEASE, 1, properties, coords,
                        0, 0, 1.0f, 1.0f, 0, 0, source, 0
                    )
                    try {
                        val setActionButtonMethod = MotionEvent::class.java.getMethod("setActionButton", Int::class.javaPrimitiveType)
                        setActionButtonMethod.invoke(releaseEvent, finalButtonState)
                    } catch (e: Exception) {}
                    injectInputEventMethod.invoke(inputManagerInstance, releaseEvent, 0)
                    releaseEvent.recycle()

                    // 2. ACTION_UP
                    val upEvent = MotionEvent.obtain(
                        downTime, eventTime, MotionEvent.ACTION_UP, 1, properties, coords,
                        0, 0, 1.0f, 1.0f, 0, 0, source, 0
                    )
                    injectInputEventMethod.invoke(inputManagerInstance, upEvent, 0)
                    upEvent.recycle()
                    downTime = 0L
                    return
                }
            }

            // Normal touch event injection or fallback
            val event = MotionEvent.obtain(
                if (action == MotionEvent.ACTION_SCROLL) eventTime else downTime,
                eventTime,
                action,
                1,
                properties,
                coords,
                0,
                finalButtonState,
                1.0f,
                1.0f,
                0,
                0,
                source,
                0
            )
            injectInputEventMethod.invoke(inputManagerInstance, event, 0)
            event.recycle()

        } catch (e: Exception) {
            android.util.Log.e("MouseInjector", "Error injecting input event: " + e.message, e)
            e.printStackTrace()
        }

        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            downTime = 0L
        }
    }
}
