package leap.scrcpy.server

import android.annotation.SuppressLint
import android.app.Application
import android.app.Instrumentation
import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import java.lang.reflect.Constructor
import java.lang.reflect.Field

@SuppressLint("PrivateApi", "BlockedPrivateApi", "SoonBlockedPrivateApi", "DiscouragedPrivateApi")
object Workarounds {
    private var ACTIVITY_THREAD_CLASS: Class<*>? = null
    private var ACTIVITY_THREAD: Any? = null

    init {
        try {
            ACTIVITY_THREAD_CLASS = Class.forName("android.app.ActivityThread")
            val activityThreadConstructor: Constructor<*> = ACTIVITY_THREAD_CLASS!!.getDeclaredConstructor()
            activityThreadConstructor.isAccessible = true
            ACTIVITY_THREAD = activityThreadConstructor.newInstance()

            val sCurrentActivityThreadField: Field = ACTIVITY_THREAD_CLASS!!.getDeclaredField("sCurrentActivityThread")
            sCurrentActivityThreadField.isAccessible = true
            sCurrentActivityThreadField.set(null, ACTIVITY_THREAD)

            val mSystemThreadField: Field = ACTIVITY_THREAD_CLASS!!.getDeclaredField("mSystemThread")
            mSystemThreadField.isAccessible = true
            mSystemThreadField.setBoolean(ACTIVITY_THREAD, true)
        } catch (e: Exception) {
            // Ignore
        }
    }

    fun apply() {
        try {
            val app = Instrumentation.newApplication(Application::class.java, FakeContext.instance)
            val mInitialApplicationField: Field = ACTIVITY_THREAD_CLASS!!.getDeclaredField("mInitialApplication")
            mInitialApplicationField.isAccessible = true
            mInitialApplicationField.set(ACTIVITY_THREAD, app)
        } catch (e: Exception) {
            // Ignore
        }
    }

    fun getSystemContext(): Context? {
        return try {
            val getSystemContextMethod = ACTIVITY_THREAD_CLASS!!.getDeclaredMethod("getSystemContext")
            getSystemContextMethod.invoke(ACTIVITY_THREAD) as Context
        } catch (e: Exception) {
            null
        }
    }
}
