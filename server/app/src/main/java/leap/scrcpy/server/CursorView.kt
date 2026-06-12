package leap.scrcpy.server

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.View

class CursorView(context: Context) : View(context) {
    private val path = Path().apply {
        moveTo(0f, 0f)
        lineTo(0f, 48f)
        lineTo(12f, 36f)
        lineTo(22f, 54f)
        lineTo(28f, 50f)
        lineTo(18f, 33f)
        lineTo(32f, 32f)
        close()
    }

    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.FILL
    }

    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK
        style = Paint.Style.STROKE
        strokeWidth = 4f
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // Bounding box of path is 32x54. Add padding for the 4px stroke and anti-aliasing.
        setMeasuredDimension(40, 64)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        // Apply slight translation to offset the stroke border padding
        canvas.save()
        canvas.translate(4f, 4f)
        canvas.drawPath(path, fillPaint)
        canvas.drawPath(path, strokePaint)
        canvas.restore()
    }
}
