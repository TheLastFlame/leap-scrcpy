package leap.scrcpy.server

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.provider.Settings
import android.text.TextUtils
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private lateinit var statusText: TextView
    private lateinit var settingsButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val layout = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            setPadding(50, 50, 50, 50)
        }

        statusText = TextView(this).apply {
            textSize = 18f
            gravity = android.view.Gravity.CENTER
            text = "Checking Accessibility Service status..."
        }
        layout.addView(statusText)

        settingsButton = Button(this).apply {
            text = "Open Accessibility Settings"
            visibility = android.view.View.GONE
            setOnClickListener {
                val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                startActivity(intent)
            }
        }
        layout.addView(settingsButton)

        setContentView(layout)
    }

    override fun onResume() {
        super.onResume()
        checkAccessibilityService()
    }

    private fun checkAccessibilityService() {
        if (isAccessibilityServiceEnabled()) {
            statusText.text = "Leap Scrcpy Accessibility Service is enabled and running!"
            settingsButton.visibility = android.view.View.GONE
            // Close after 2 seconds automatically to return to background
            Handler(mainLooper).postDelayed({
                finish()
            }, 2000)
        } else {
            statusText.text = "This app requires you to enable the Accessibility Service to draw the cursor.\n\n" +
                    "Please locate 'Leap Scrcpy Cursor' in the list and turn it ON.\n\n" +
                    "(If options are blocked/grayed out, go to App Info and choose 'Allow restricted settings' first)"
            settingsButton.visibility = android.view.View.VISIBLE
            
            // Direct user to settings immediately on launch
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            startActivity(intent)
        }
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val expectedComponentName = ComponentName(this, CursorAccessibilityService::class.java)
        val enabledServices = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val colonSplitter = TextUtils.SimpleStringSplitter(':')
        colonSplitter.setString(enabledServices)
        while (colonSplitter.hasNext()) {
            val componentNameString = colonSplitter.next()
            val enabledService = ComponentName.unflattenFromString(componentNameString)
            if (enabledService != null && enabledService == expectedComponentName) {
                return true
            }
        }
        return false
    }
}
