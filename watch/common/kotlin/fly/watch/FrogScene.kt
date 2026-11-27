package fly.watch

// The frog and the toad on the watch (FlyWorld, Frogs.kt), drawn from sprite frames rendered
// from the website's frog models (watch/tools/frogs.html): sitting, hopping, and striking with
// the mouth open, the tongue drawn here from the mouth to wherever the fly is. A frog some way
// behind the path stands on the far view (Scenery.far, tools/scenery.html): it is drawn where
// that picture shows the ground at its distance, at that picture's scale, and scrolls with it,
// so it stays put on the ground as the view follows the fly.

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

/**
 * Where something `depth` mm behind the path is in the far view: its scale (1 at the seam with
 * the near strip), how far up the screen its ground is (mm at the path's scale), and where it
 * is across the screen for stage x (mm at the path's scale, before the view's scroll). The far
 * view is one perspective picture whose focal length makes the seam (depth D/parallax - D)
 * match the near strip (scenery.html).
 */
private class Far(sc: Scenery, depth: Float) {
    private val f = CAM_D / sc.parallax                   // the far camera's focal length, in mm at the path
    private val dist = CAM_D + depth * COS17
    val scale = f / dist
    val rise = f * depth * SIN17 / dist
}

/** Screen x of stage x at `depth`: it scrolls with the far view (sc.parallax), not with the path. */
private fun DrawScope.farX(sc: Scenery, v: View, far: Far, x: Float) = size.width / 2 + (x * far.scale - v.camX * sc.parallax) * v.k

private val Tongue = Color(0xFFE0828E)
private val TongueTip = Color(0xFFF2A7B0)

/** Where a frog's mouth is on screen (for its tongue). */
private fun mouthAt(fv: FrogView, sp: FrogSprite, x: Float, gy: Float, sc: Float) =
    Offset(x + fv.facing * (sp.mouth.x - sp.originCol) * sc, gy + (sp.mouth.y - sp.groundRow) * sc)

/** The frogs behind the path, furthest first. */
fun DrawScope.drawFrogs(f: Frame, frogs: FrogSprites, sc0: Scenery, v: View, groundY: Float) {
    for (fv in f.frogs.sortedByDescending { it.depth }) {
        val sp = frogs.byId[fv.id] ?: continue
        val far = Far(sc0, fv.depth.toFloat())
        val s = far.scale
        val x = farX(sc0, v, far, fv.x.toFloat())
        val gy = groundY - far.rise * v.k
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
fun DrawScope.drawTongues(f: Frame, frogs: FrogSprites, sc0: Scenery, v: View, groundY: Float, fly: Offset) {
    for (fv in f.frogs) {
        if (fv.tongueOut <= 0.01) continue
        val sp = frogs.byId[fv.id] ?: continue
        val far = Far(sc0, fv.depth.toFloat())
        val s = far.scale
        val x = farX(sc0, v, far, fv.x.toFloat())
        val gy = groundY - far.rise * v.k
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

/** How far the view pulls back while a frog hunts near the fly (1: not at all; 0.4: two and a half times as wide). */
fun frogZoom(f: Frame): Float =
    if (f.frogs.any { it.hunting && kotlin.math.abs(it.x - f.x) < 90 }) 0.4f else 1f
