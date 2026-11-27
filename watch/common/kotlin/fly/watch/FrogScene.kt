package fly.watch

// The frog and the toad on the watch (FlyWorld, Frogs.kt), drawn from sprite frames rendered
// from the website's frog models (watch/tools/frogs.html): sitting, hopping, and striking with
// the mouth open, the tongue drawn here from the mouth to wherever the fly is. A frog some way
// behind the path is drawn smaller and higher on the screen, with the sprites' perspective.

import android.graphics.BitmapFactory
import androidx.activity.ComponentActivity
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import fly.game.FrogMode
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/** One frame, cropped to the frog: its image and where it sat in the full frame. */
class FrogFrame(val img: ImageBitmap, val left: Int, val top: Int)

class FrogSprite(
    val pxPerMm: Float, val length: Float, val originCol: Float, val groundRow: Float, val mouth: Offset,
    val frames: Map<String, List<FrogFrame>>,
)

class FrogSprites(val byId: Map<String, FrogSprite>) {
    companion object {
        /** From assets/frogs (frogs.json and the WebP frames); null if they are missing. */
        fun load(a: ComponentActivity): FrogSprites? = try {
            val metas = org.json.JSONArray(a.assets.open("frogs/frogs.json").use { it.readBytes().decodeToString() })
            val map = HashMap<String, FrogSprite>()
            for (i in 0 until metas.length()) {
                val m = metas.getJSONObject(i)
                val id = m.getString("id")
                val crops = m.getJSONObject("crops")
                val counts = m.getJSONObject("counts")
                val frames = HashMap<String, List<FrogFrame>>()
                for (anim in counts.keys()) {
                    frames[anim] = (0 until counts.getInt(anim)).map { k ->
                        val name = "${id}_${anim}_${k.toString().padStart(2, '0')}"
                        val box = crops.getJSONArray(name)
                        val img = a.assets.open("frogs/$name.webp").use { BitmapFactory.decodeStream(it).asImageBitmap() }
                        FrogFrame(img, box.getInt(0), box.getInt(1))
                    }
                }
                val mp = m.getJSONArray("mouthPx")
                map[id] = FrogSprite(
                    m.getDouble("pxPerMm").toFloat(), m.getDouble("length").toFloat(), m.getDouble("originCol").toFloat(),
                    m.getDouble("groundRow").toFloat(), Offset(mp.getDouble(0).toFloat(), mp.getDouble(1).toFloat()), frames,
                )
            }
            FrogSprites(map)
        } catch (e: Exception) {
            null
        }
    }
}

/** The sprite camera: 11.16 mm from the fly, 17 degrees down (sprites.html). */
private const val CAM_D = 11.16f
private val COS17 = cos(Math.toRadians(17.0)).toFloat()
private val SIN17 = sin(Math.toRadians(17.0)).toFloat()

/** How much smaller something `depth` mm behind the path looks, and how far up the screen its ground is (in mm at the path). */
fun depthScale(depth: Float) = CAM_D / (CAM_D + depth * COS17)
fun depthRise(depth: Float) = CAM_D * depth * SIN17 / (CAM_D + depth * COS17)

private val Tongue = Color(0xFFE0828E)
private val TongueTip = Color(0xFFF2A7B0)

/** Where a frog's mouth is on screen (for its tongue). */
private fun mouthAt(fv: FrogView, sp: FrogSprite, x: Float, gy: Float, sc: Float) =
    Offset(x + fv.facing * (sp.mouth.x - sp.originCol) * sc, gy + (sp.mouth.y - sp.groundRow) * sc)

/** The frogs behind the path, furthest first. */
fun DrawScope.drawFrogs(f: Frame, frogs: FrogSprites, v: View, groundY: Float) {
    for (fv in f.frogs.sortedByDescending { it.depth }) {
        val sp = frogs.byId[fv.id] ?: continue
        val d = fv.depth.toFloat()
        val s = depthScale(d)
        val x = size.width / 2 + (fv.x.toFloat() - v.camX) * v.k * s
        val gy = groundY - depthRise(d) * v.k
        val sc = v.k * s / sp.pxPerMm                          // screen px per sprite px
        val half = sp.length * 1.8f * v.k * s
        if (x + half < 0 || x - half > size.width) continue
        val anim = when (fv.mode) { FrogMode.SIT -> "sit"; FrogMode.HOP -> "hop"; FrogMode.STRIKE -> "strike" }
        val fr = sp.frames[anim]?.getOrNull(fv.frame) ?: continue
        // a soft shadow under it
        val sw = sp.length * 0.75f * v.k * s
        drawOval(Color(0x38000000), Offset(x - sw / 2 + fv.facing * sw * 0.1f, gy - sw * 0.06f), Size(sw, sw * 0.14f))
        scale(scaleX = fv.facing.toFloat(), scaleY = 1f, pivot = Offset(x, gy)) {
            drawImage(
                fr.img,
                dstOffset = IntOffset((x + (fr.left - sp.originCol) * sc).roundToInt(), (gy + (fr.top - sp.groundRow) * sc).roundToInt()),
                dstSize = IntSize((fr.img.width * sc).roundToInt().coerceAtLeast(1), (fr.img.height * sc).roundToInt().coerceAtLeast(1)),
            )
        }
    }
}

/** Tongues out at the fly (drawn over it), with the fly on the tip if caught. */
fun DrawScope.drawTongues(f: Frame, frogs: FrogSprites, v: View, groundY: Float, fly: Offset) {
    for (fv in f.frogs) {
        if (fv.tongueOut <= 0.01) continue
        val sp = frogs.byId[fv.id] ?: continue
        val d = fv.depth.toFloat()
        val s = depthScale(d)
        val x = size.width / 2 + (fv.x.toFloat() - v.camX) * v.k * s
        val gy = groundY - depthRise(d) * v.k
        val mouth = mouthAt(fv, sp, x, gy, v.k * s / sp.pxPerMm)
        val out = fv.tongueOut.toFloat()
        val tip = Offset(mouth.x + (fly.x - mouth.x) * out, mouth.y + (fly.y - mouth.y) * out)
        val w = (sp.length * 0.045f * v.k * s).coerceAtLeast(3f)
        drawLine(Tongue, mouth, tip, strokeWidth = w, cap = StrokeCap.Round)
        drawLine(TongueTip.copy(alpha = 0.6f), mouth, tip, strokeWidth = w * 0.35f, cap = StrokeCap.Round)
        drawCircle(TongueTip, w * 1.2f, tip)
        if (fv.holding) {
            // the fly, stuck to the tip
            drawOval(Color(0xFF6B3A1E), Offset(tip.x - w * 1.3f, tip.y - w * 0.8f), Size(w * 2.6f, w * 1.6f))
            drawCircle(Color(0xFFB8322A), w * 0.55f, Offset(tip.x + fv.facing * -w * 1.2f, tip.y - w * 0.2f))
        }
    }
}

/** How far the view pulls back while a frog hunts near the fly (1: not at all; 0.5: twice as wide). */
fun frogZoom(f: Frame): Float =
    if (f.frogs.any { it.hunting && kotlin.math.abs(it.x - f.x) < 90 }) 0.5f else 1f
