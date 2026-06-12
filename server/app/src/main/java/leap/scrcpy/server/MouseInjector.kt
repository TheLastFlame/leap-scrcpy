package leap.scrcpy.server

import android.os.Build
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.MotionEvent.PointerCoords
import android.view.MotionEvent.PointerProperties
import android.view.InputEvent
import java.lang.reflect.Method

object MouseInjector {
    private const val INJECT_INPUT_EVENT_MODE_ASYNC = 0

    private val inputManagerInstance: Any by lazy {
        try {
            FakeContext.instance.getSystemService(android.content.Context.INPUT_SERVICE)!!
        } catch (e: Exception) {
            val inputManagerClass = Class.forName("android.hardware.input.InputManager")
            val getInstanceMethod = inputManagerClass.getDeclaredMethod("getInstance")
            getInstanceMethod.isAccessible = true
            getInstanceMethod.invoke(null)!!
        }
    }

    private val injectInputEventMethod by lazy {
        val inputManagerClass = inputManagerInstance.javaClass
        inputManagerClass.getMethod(
            "injectInputEvent",
            android.view.InputEvent::class.java,
            Int::class.javaPrimitiveType
        ).apply {
            isAccessible = true
        }
    }

    private val setDisplayIdMethod: Method? by lazy {
        try {
            InputEvent::class.java.getMethod("setDisplayId", Int::class.javaPrimitiveType).apply {
                isAccessible = true
            }
        } catch (e: Exception) {
            null
        }
    }

    private val setActionButtonMethod: Method? by lazy {
        try {
            MotionEvent::class.java.getMethod("setActionButton", Int::class.javaPrimitiveType).apply {
                isAccessible = true
            }
        } catch (e: Exception) {
            null
        }
    }

    // Reuse objects to avoid GC pressure, matching scrcpy's Controller.java
    private val pointerProperties = arrayOf(PointerProperties().apply {
        id = 0
        toolType = MotionEvent.TOOL_TYPE_MOUSE
    })
    private val pointerCoords = arrayOf(PointerCoords().apply {
        pressure = 1.0f
        size = 1.0f
    })

    private var downTime: Long = 0
    private var activeSource = InputDevice.SOURCE_MOUSE
    private var activeTool = MotionEvent.TOOL_TYPE_MOUSE

    fun inject(action: Int, x: Float, y: Float, buttonState: Int, vscroll: Float, hscroll: Float) {
        val now = SystemClock.uptimeMillis()
        
        if (action == MotionEvent.ACTION_DOWN) {
            downTime = now
        } else if (downTime == 0L) {
            downTime = now
        }

        val activeSecondaryButtons = (buttonState and 1.inv()) != 0
        
        if (action == MotionEvent.ACTION_DOWN) {
            if (activeSecondaryButtons) {
                activeSource = InputDevice.SOURCE_MOUSE
                activeTool = MotionEvent.TOOL_TYPE_MOUSE
            } else {
                activeSource = InputDevice.SOURCE_TOUCHSCREEN
                activeTool = MotionEvent.TOOL_TYPE_FINGER
            }
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

        pointerProperties[0].toolType = tool
        pointerCoords[0].x = x
        pointerCoords[0].y = y
        pointerCoords[0].pressure = if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_HOVER_MOVE) 0.0f else 1.0f
        
        if (action == MotionEvent.ACTION_SCROLL) {
            pointerCoords[0].setAxisValue(MotionEvent.AXIS_VSCROLL, vscroll)
            pointerCoords[0].setAxisValue(MotionEvent.AXIS_HSCROLL, hscroll)
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && source == InputDevice.SOURCE_MOUSE) {
                if (action == MotionEvent.ACTION_DOWN) {
                    val downEvent = MotionEvent.obtain(
                        downTime, now, MotionEvent.ACTION_DOWN, 1, pointerProperties, pointerCoords,
                        0, finalButtonState, 1.0f, 1.0f, 0, 0, source, 0
                    )
                    injectInternal(downEvent)

                    val pressEvent = MotionEvent.obtain(
                        downTime, now, MotionEvent.ACTION_BUTTON_PRESS, 1, pointerProperties, pointerCoords,
                        0, finalButtonState, 1.0f, 1.0f, 0, 0, source, 0
                    )
                    setActionButtonMethod?.invoke(pressEvent, finalButtonState)
                    injectInternal(pressEvent)
                    return
                }

                if (action == MotionEvent.ACTION_UP) {
                    val releaseEvent = MotionEvent.obtain(
                        downTime, now, MotionEvent.ACTION_BUTTON_RELEASE, 1, pointerProperties, pointerCoords,
                        0, 0, 1.0f, 1.0f, 0, 0, source, 0
                    )
                    setActionButtonMethod?.invoke(releaseEvent, finalButtonState)
                    injectInternal(releaseEvent)

                    val upEvent = MotionEvent.obtain(
                        downTime, now, MotionEvent.ACTION_UP, 1, pointerProperties, pointerCoords,
                        0, 0, 1.0f, 1.0f, 0, 0, source, 0
                    )
                    injectInternal(upEvent)
                    downTime = 0L
                    return
                }
            }

            val event = MotionEvent.obtain(
                if (action == MotionEvent.ACTION_SCROLL) now else downTime,
                now, action, 1, pointerProperties, pointerCoords,
                0, finalButtonState, 1.0f, 1.0f, 0, 0, source, 0
            )
            injectInternal(event)

        } catch (e: Exception) {
            android.util.Log.e("MouseInjector", "Error: " + e.message)
        }

        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            downTime = 0L
        }
    }

    private fun injectInternal(event: MotionEvent) {
        // Support for multi-display coordinate systems, matching scrcpy
        setDisplayIdMethod?.invoke(event, 0)
        injectInputEventMethod.invoke(inputManagerInstance, event, INJECT_INPUT_EVENT_MODE_ASYNC)
        event.recycle()
    }
}
