package leap.scrcpy.server

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.view.View

class CursorView(context: Context) : View(context) {
    private val bitmap: Bitmap = BitmapFactory.decodeResource(context.resources, R.drawable.pointer_arrow)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(bitmap.width, bitmap.height)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawBitmap(bitmap, 0f, 0f, null)
    }
}
