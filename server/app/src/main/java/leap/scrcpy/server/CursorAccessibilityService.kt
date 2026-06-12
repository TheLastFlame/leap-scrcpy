package leap.scrcpy.server

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import java.io.DataInputStream
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

class CursorAccessibilityService : AccessibilityService() {
    private lateinit var windowManager: WindowManager
    private lateinit var cursorView: CursorView
    private lateinit var layoutParams: WindowManager.LayoutParams
    private val mainHandler = Handler(Looper.getMainLooper())
    private var serverSocket: ServerSocket? = null
    private var isRunning = false

    private var serverWidth = 1
    private var serverHeight = 1

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    override fun onServiceConnected() {
        super.onServiceConnected()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        cursorView = CursorView(this).apply {
            visibility = View.GONE
        }

        layoutParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = 0
        }

        windowManager.addView(cursorView, layoutParams)
        startServer()
    }

    private fun startServer() {
        isRunning = true
        thread(start = true, name = "CursorServerThread") {
            try {
                serverSocket = ServerSocket(18400)
                while (isRunning) {
                    val socket = serverSocket?.accept() ?: break
                    handleClient(socket)
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    private fun handleClient(socket: Socket) {
        thread(start = true, name = "CursorClientThread") {
            try {
                val dis = DataInputStream(socket.getInputStream())
                while (isRunning) {
                    val command = dis.readByte().toInt()
                    when (command) {
                        0 -> { // Hide
                            mainHandler.post {
                                cursorView.visibility = View.GONE
                            }
                        }
                        1 -> { // Show
                            mainHandler.post {
                                cursorView.visibility = View.VISIBLE
                            }
                        }
                        2 -> { // Move
                            val x = dis.readInt()
                            val y = dis.readInt()

                            // Get real screen bounds including navigation bar and status bar
                            val deviceWidth: Int
                            val deviceHeight: Int
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                                val bounds = windowManager.currentWindowMetrics.bounds
                                deviceWidth = bounds.width()
                                deviceHeight = bounds.height()
                            } else {
                                val realMetrics = DisplayMetrics()
                                @Suppress("DEPRECATION")
                                windowManager.defaultDisplay.getRealMetrics(realMetrics)
                                deviceWidth = realMetrics.widthPixels
                                deviceHeight = realMetrics.heightPixels
                            }

                            val scaleX = deviceWidth.toFloat() / serverWidth
                            val scaleY = deviceHeight.toFloat() / serverHeight

                            mainHandler.post {
                                layoutParams.x = (x * scaleX).toInt()
                                layoutParams.y = (y * scaleY).toInt()
                                windowManager.updateViewLayout(cursorView, layoutParams)
                            }
                        }
                        3 -> { // Set Server Dimensions
                            serverWidth = dis.readInt()
                            serverHeight = dis.readInt()
                        }
                    }
                }
            } catch (e: Exception) {
                // Connection closed or error
            } finally {
                try {
                    socket.close()
                } catch (e: Exception) {}
                mainHandler.post {
                    cursorView.visibility = View.GONE
                }
            }
        }
    }

    override fun onDestroy() {
        isRunning = false
        try {
            serverSocket?.close()
        } catch (e: Exception) {}
        try {
            windowManager.removeView(cursorView)
        } catch (e: Exception) {}
        super.onDestroy()
    }
}
