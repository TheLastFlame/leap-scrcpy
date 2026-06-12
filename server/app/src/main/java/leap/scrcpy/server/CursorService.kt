package leap.scrcpy.server

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import java.io.DataInputStream
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

class CursorService : Service() {
    private lateinit var windowManager: WindowManager
    private lateinit var cursorView: CursorView
    private lateinit var layoutParams: WindowManager.LayoutParams
    private val mainHandler = Handler(Looper.getMainLooper())
    private var serverSocket: ServerSocket? = null
    private var isRunning = false

    @Volatile private var pendingX = 0
    @Volatile private var pendingY = 0
    @Volatile private var isUpdatePending = false

    private val updateRunnable = Runnable {
        layoutParams.x = pendingX
        layoutParams.y = pendingY
        windowManager.updateViewLayout(cursorView, layoutParams)
        isUpdatePending = false
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        cursorView = CursorView(this).apply {
            visibility = View.GONE
        }

        layoutParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = 0
        }

        windowManager.addView(cursorView, layoutParams)
        startForegroundService()
        startServer()
    }

    private fun startForegroundService() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channelId = "leap_scrcpy_cursor"
            val channelName = "Leap Scrcpy Cursor Service"
            val channel = NotificationChannel(channelId, channelName, NotificationManager.IMPORTANCE_LOW)
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)

            val notification = Notification.Builder(this, channelId)
                .setContentTitle("Leap Scrcpy Cursor")
                .setContentText("Cursor overlay service is running")
                .build()

            startForeground(1, notification)
        }
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
        socket.tcpNoDelay = true
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

                            pendingX = x
                            pendingY = y

                            if (!isUpdatePending) {
                                isUpdatePending = true
                                mainHandler.post(updateRunnable)
                            }
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