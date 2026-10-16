package fly.watch

// The game's scene, shared by the watch (app) and phone (phone) apps: the pre-rendered fly
// sprites, the grass-arena scenery layers, and drawing them for a frame of the world.

import android.graphics.BitmapFactory
import androidx.activity.ComponentActivity
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import fly.game.Anim
import fly.game.FlyWorld
import kotlin.math.roundToInt

/** Pre-rendered FlyBody frames (watch/tools/sprites.html), all facing right. */
class Sprites(val frames: Map<String, List<ImageBitmap>>) {
    fun pick(f: Frame): ImageBitmap = when (f.anim) {
        Anim.IDLE -> frames.getValue("idle").let { it[(f.animTime * 6).toInt() % it.size] }
        Anim.WALK -> frames.getValue("walk").let { it[(((f.walkPhase % 1) + 1) % 1 * it.size).toInt().coerceIn(0, it.size - 1)] }
        Anim.FEED -> frames.getValue("feed").let { it[(f.proboscis * 5).roundToInt().coerceIn(0, 5)] }
        Anim.FLY -> frames.getValue("fly").let { it[(f.animTime * 25).toInt() % it.size] }
        Anim.SLEEP -> frames.getValue("sleep")[0]
        // Frames 0-5 head sweeps, 6-11 leg rubbing, alternating every 1.1 s (DNg12).
        Anim.GROOM -> frames.getValue("groom").let {
            val rub = (f.animTime / 1.1).toInt() % 2 == 1
            it[(if (rub) 6 else 0) + ((f.animTime * (if (rub) 5 else 3) * 6).toInt() % 6)]
        }
    }

    companion object {
        fun load(a: ComponentActivity): Sprites {
            val names = a.assets.list("sprites")!!.sorted()
            val frames = names.groupBy { it.substringBefore("_") }.mapValues { (_, list) ->
                list.map { n -> a.assets.open("sprites/$n").use { BitmapFactory.decodeStream(it).asImageBitmap() } }
            }
            return Sprites(frames)
        }
    }
}

/**
 * The website's grass arena (watch/tools/scenery.html), in three layers at the sprites' scale
 * and viewing angle: the grass and weeds just behind the fly's path and the grass in front of
 * it (strips that scroll with the stage), and a far view to the arena's edge that scrolls with
 * parallax.
 */
class Scenery(
    val near: ImageBitmap, val front: ImageBitmap, val far: ImageBitmap,
    val pxPerMm: Float, val x0: Float, val farX0: Float, val feetRow: Float, val parallax: Float,
) {
    companion object {
        fun load(a: ComponentActivity): Scenery {
            val m = org.json.JSONObject(a.assets.open("scenery/scenery.json").use { it.readBytes().decodeToString() })
            fun img(name: String, opaque: Boolean) = a.assets.open("scenery/$name").use {
                val o = BitmapFactory.Options().apply { if (opaque) inPreferredConfig = android.graphics.Bitmap.Config.RGB_565 }
                BitmapFactory.decodeStream(it, null, o)!!.asImageBitmap()
            }
            return Scenery(
                img("near.webp", false), img("front.webp", false), img("far.webp", true),
                m.getDouble("pxPerMm").toFloat(), m.getDouble("x0").toFloat(), m.getDouble("farX0").toFloat(),
                m.getDouble("feetRow").toFloat(), m.getDouble("parallax").toFloat(),
            )
        }
    }
}

/** The view: the sprites' scale (px per mm) and where the camera looks along the stage. */
data class View(val k: Float, val camX: Float, val camZ: Float, val standY: Float)

/** Sprite frames show a 5.98 mm square at the fly (sprites.html camera: 30 deg at 11.16 mm). */
const val SPRITE_MM = 5.98f

fun viewFor(f: Frame, w: Float, h: Float, flySize: Float, standLine: Float = STAND_LINE): View {
    val k = flySize / SPRITE_MM
    val half = w / 2 / k
    val lim = (FlyWorld.HALF_WIDTH.toFloat() - half).coerceAtLeast(0f)
    val camX = f.x.toFloat().coerceIn(-lim, lim)
    val camZ = (f.z.toFloat() - 2.5f).coerceAtLeast(0f) // follow a flying fly up
    return View(k, camX, camZ, h * standLine)
}


val Amber = Color(0xFFE6A84A)
val EnergyBlue = Color(0xFF7FB6E8)
val MoodPink = Color(0xFFE88FA8)
val Ink = Color(0xFFF4EDE2)

const val STAND_LINE = 0.71f   // fraction of the screen height where the fly's feet rest
const val FEET_LINE = 0.756f   // claws' row in the 320 px sprite frames (watch/tools/sprites.html)

/**
 * Draws the on-screen part of a scenery layer. col0 is the layer's column for stage x = 0 and
 * row0 its row for the feet line; it scrolls sideways `rate` times as fast as the stage (all
 * layers move together vertically, so their seams stay joined when the view rises).
 */
fun DrawScope.drawLayer(img: ImageBitmap, sc: Scenery, v: View, col0: Float, row0: Float, rate: Float) {
    val s = v.k / sc.pxPerMm                      // screen px per layer px
    // Layer pixel under the screen's top-left corner.
    var u0 = col0 + (v.camX * rate - size.width / 2 / v.k) * sc.pxPerMm
    var v0 = row0 - (v.standY + v.camZ * v.k) / s
    var uw = size.width / s
    var vh = size.height / s
    var dx = 0f
    var dy = 0f
    if (u0 < 0) { dx = -u0 * s; uw += u0; u0 = 0f }
    if (v0 < 0) { dy = -v0 * s; vh += v0; v0 = 0f }
    uw = uw.coerceAtMost(img.width - u0)
    vh = vh.coerceAtMost(img.height - v0)
    if (uw <= 1 || vh <= 1) return
    drawImage(
        img, srcOffset = IntOffset(u0.toInt(), v0.toInt()), srcSize = IntSize(uw.toInt(), vh.toInt()),
        dstOffset = IntOffset(dx.toInt(), dy.toInt()), dstSize = IntSize((uw * s).roundToInt(), (vh * s).roundToInt()),
    )
}

fun DrawScope.drawScene(f: Frame, sprites: Sprites, sc: Scenery, v: View, flySize: Float) {
    val w = size.width
    // The grass arena behind the path.
    drawRect(Color(0xFF0D0C0A))
    drawLayer(sc.far, sc, v, sc.farX0, sc.feetRow, sc.parallax)
    drawLayer(sc.near, sc, v, sc.x0, sc.feetRow, 1f)
    val sx = { x: Double -> w / 2 + (x.toFloat() - v.camX) * v.k }
    val groundY = v.standY + v.camZ * v.k
    // Sugar drops at true size (2 mm across when full), glossy and flat.
    for ((fx, amount) in f.food) {
        val cx = sx(fx)
        val r = FlyWorld.FOOD_RADIUS.toFloat() * v.k * (0.45f + 0.55f * (amount / 30.0).toFloat().coerceIn(0f, 1f))
        drawOval(Color(0xE6D9A441), Offset(cx - r, groundY - r * 0.32f), Size(2 * r, r * 0.55f))
        drawOval(Color(0xAAFFF4D6), Offset(cx - r * 0.5f, groundY - r * 0.28f), Size(r * 0.55f, r * 0.16f))
    }
    // The fly: its claws are FEET_LINE of the way down each sprite frame.
    val img = sprites.pick(f)
    val px = sx(f.x)
    val top = groundY - f.z.toFloat() * v.k - flySize * FEET_LINE
    val shadow = (1f - f.z.toFloat() / 15f).coerceIn(0.2f, 1f)
    drawOval(Color(0x33000000).copy(alpha = 0.2f * shadow), Offset(px - flySize * 0.22f * shadow, groundY - 3f), Size(flySize * 0.44f * shadow, 7f))
    scale(scaleX = f.facing.toFloat(), scaleY = 1f, pivot = Offset(px, top + flySize / 2)) {
        drawImage(
            img, dstOffset = IntOffset((px - flySize / 2).toInt(), top.toInt()),
            dstSize = IntSize(flySize.toInt(), flySize.toInt()),
        )
    }
    // Grass in front of the path, over the fly's feet.
    drawLayer(sc.front, sc, v, sc.x0, sc.feetRow, 1f)
    // Sugar off screen: a small arrow at that edge.
    for ((fx, _) in f.food) {
        val cx = sx(fx)
        if (cx < 0 || cx > w) {
            val ex = if (cx < 0) 18f else w - 18f
            val d = if (cx < 0) -1f else 1f
            val path = androidx.compose.ui.graphics.Path().apply {
                moveTo(ex + d * 10f, groundY - 8f); lineTo(ex - d * 4f, groundY - 16f); lineTo(ex - d * 4f, groundY); close()
            }
            drawPath(path, Amber)
        }
    }
    if (f.night) drawRect(Color(0x8C06102A)) // moonlight
    if (f.anim == Anim.SLEEP) {
        val t = (f.animTime % 2.0).toFloat()
        drawContext.canvas.nativeCanvas.apply {
            val paint = android.graphics.Paint().apply { color = 0xCCF4EDE2.toInt(); textSize = 22f; isAntiAlias = true }
            drawText("z", px + flySize * 0.2f, top + flySize * 0.25f - t * 12, paint)
            drawText("Z", px + flySize * 0.28f, top + flySize * 0.12f - t * 12, paint.apply { textSize = 28f })
        }
    }
}
