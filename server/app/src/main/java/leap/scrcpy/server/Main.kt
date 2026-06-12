package leap.scrcpy.server

import android.annotation.SuppressLint
import android.content.res.Configuration
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.hardware.display.DisplayManager.DisplayListener
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.IDisplayWindowListener
import leap.scrcpy.server.messages.ClipboardMessage
import leap.scrcpy.server.messages.DisplayInfoMessage
import leap.scrcpy.server.messages.VersionMessage
import leap.scrcpy.server.request.ClipboardRequest
import leap.scrcpy.server.request.UHidRequest
import leap.scrcpy.server.request.InjectRequest
import org.joor.Reflect
import java.io.DataInputStream
import java.io.DataOutputStream

@SuppressLint("DiscouragedPrivateApi", "PrivateApi")
object Main {
    private val displayManagerGlobal: Reflect by lazy {
        Reflect.onClass("android.hardware.display.DisplayManagerGlobal").call("getInstance")
    }

    @Volatile
    private var activeSocketOutputStream: DataOutputStream? = null

    private fun getDisplayInfo(): DisplayInfoMessage {
        val displayInfo = displayManagerGlobal.call("getDisplayInfo", 0)
        return DisplayInfoMessage(
            displayInfo.call("getNaturalWidth").get(),
            displayInfo.call("getNaturalHeight").get(),
            displayInfo.get("rotation")
        )
    }

    @JvmStatic
    fun main(vararg args: String) {
        Workarounds.apply()
        System.setErr(java.io.PrintStream(object : java.io.OutputStream() {
            private val buffer = StringBuilder()
            override fun write(b: Int) {
                if (b == '\n'.code) {
                    Log.e("LeapScrcpyErr", buffer.toString())
                    buffer.setLength(0)
                } else {
                    buffer.append(b.toChar())
                }
            }
        }, true))

        Looper.prepare()

        val systemOutStream = DataOutputStream(System.out)
        VersionMessage.serialize(systemOutStream)

        var lastDisplayInfo = getDisplayInfo()
        lastDisplayInfo.serialize(systemOutStream)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val windowManagerBinder =
                Reflect.onClass("android.os.ServiceManager").call("getService", "window")
                    .get<IBinder>()
            val windowManager = Reflect.onClass("android.view.IWindowManager\$Stub")
                .call("asInterface", windowManagerBinder)
            windowManager.call(
                "registerDisplayWindowListener",
                object : IDisplayWindowListener.Stub() {
                    override fun onDisplayAdded(displayId: Int) {}

                    override fun onDisplayConfigurationChanged(
                        displayId: Int, newConfig: Configuration
                    ) {
                        if (displayId != 0) {
                            return
                        }

                        val displayInfo = getDisplayInfo()
                        if (displayInfo != lastDisplayInfo) {
                            displayInfo.serialize(systemOutStream)
                            systemOutStream.flush()
                            Log.e(
                                "LeapScrcpy",
                                "onDisplayConfigurationChanged ${displayInfo.width} ${displayInfo.height} ${displayInfo.rotation}"
                            )
                            lastDisplayInfo = displayInfo
                        }
                    }

                    override fun onDisplayRemoved(displayId: Int) {}

                    override fun onFixedRotationStarted(displayId: Int, newRotation: Int) {}

                    override fun onFixedRotationFinished(displayId: Int) {}

                    override fun onKeepClearAreasChanged(
                        displayId: Int,
                        restricted: MutableList<Rect>?,
                        unrestricted: MutableList<Rect>?
                    ) {
                    }
                })
        } else {
            val handlerThread = HandlerThread("DisplayListener").apply { start() }
            val handler = Handler(handlerThread.getLooper())

            val displayManager = FakeContext.instance.getSystemService(DisplayManager::class.java)!!
            displayManager.registerDisplayListener(object : DisplayListener {
                override fun onDisplayAdded(displayId: Int) {
                }

                override fun onDisplayRemoved(displayId: Int) {
                }

                override fun onDisplayChanged(displayId: Int) {
                    if (displayId != 0) {
                        return
                    }

                    val displayInfo = getDisplayInfo()
                    if (displayInfo != lastDisplayInfo) {
                        displayInfo.serialize(systemOutStream)
                        systemOutStream.flush()
                        lastDisplayInfo = displayInfo
                    }
                }

            }, handler)
        }

        val clipboardThread = HandlerThread("ClipboardListener").apply { start() }
        val clipboardHandler = Handler(clipboardThread.looper)
        clipboardHandler.post {
            Log.e("LeapScrcpy", "Registering clipboard listener")
            ClipboardRequest.clipboardManager.addPrimaryClipChangedListener {
                Log.e("LeapScrcpy", "Primary clip changed")
                val clipData = ClipboardRequest.clipboardManager.primaryClip
                if (clipData != null && clipData.itemCount > 0) {
                    val text = clipData.getItemAt(0).text
                    if (text != null) {
                        Log.e("LeapScrcpy", "Clipboard content: $text")
                        val out = activeSocketOutputStream
                        if (out != null) {
                            try {
                                ClipboardMessage(text.toString()).serialize(out)
                                out.flush()
                            } catch (e: Exception) {
                                Log.e("LeapScrcpy", "Failed to send clipboard content", e)
                            }
                        } else {
                            Log.e("LeapScrcpy", "No active socket output stream to send clipboard")
                        }
                    } else {
                        Log.e("LeapScrcpy", "Clipboard item text is null")
                    }
                } else {
                    Log.e("LeapScrcpy", "ClipData is null or empty")
                }
            }
        }

        try {
            val serverSocket = java.net.ServerSocket(18402)
            val socket = serverSocket.accept()
            socket.tcpNoDelay = true

            val inputStream = DataInputStream(socket.getInputStream())
            val socketOutputStream = DataOutputStream(socket.getOutputStream())
            activeSocketOutputStream = socketOutputStream

            while (true) {
                val type = inputStream.readInt()
                when (type) {
                    0 -> ClipboardRequest.deserialize(inputStream).run(socketOutputStream)
                    1 -> UHidRequest.deserialize(inputStream).run(socketOutputStream)
                    2 -> InjectRequest.deserialize(inputStream).run(socketOutputStream)
                    else -> throw IndexOutOfBoundsException()
                }
            }
        } catch (t: Throwable) {
            Log.e("LeapScrcpyErr", "Fatal error in request loop: " + t.message, t)
            t.printStackTrace()
        } finally {
            activeSocketOutputStream = null
        }
    }
}