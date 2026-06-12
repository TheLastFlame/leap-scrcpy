package leap.scrcpy.server.request

import leap.scrcpy.server.Request
import leap.scrcpy.server.RequestFactory
import leap.scrcpy.server.MouseInjector
import java.io.DataInputStream
import java.io.DataOutputStream

data class InjectRequest(
    val action: Int,
    val x: Int,
    val y: Int,
    val buttonState: Int,
    val vscroll: Int,
    val hscroll: Int
) : Request {
    companion object : RequestFactory<InjectRequest> {
        override fun deserialize(stream: DataInputStream): InjectRequest {
            with(stream) {
                val action = readInt()
                val x = readInt()
                val y = readInt()
                val buttonState = readInt()
                val vscroll = readInt()
                val hscroll = readInt()
                return InjectRequest(action, x, y, buttonState, vscroll, hscroll)
            }
        }
    }

    override fun run(output: DataOutputStream) {
        MouseInjector.inject(action, x.toFloat(), y.toFloat(), buttonState, vscroll.toFloat(), hscroll.toFloat())
    }
}
