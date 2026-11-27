package fly.watch

// The four-leaf clover on the watch (as on the website and phone, web/src/lucky.js): one
// grows somewhere on the stage, glinting now and then. Tap it and it rises, spinning and
// turning gold, bursts into golden sparkles, a rainbow arches across the sky and gold motes
// drift down round the fly; the pet feels lucky (FlyWorld.pickClover), and the clover grows
// again a moment later somewhere else.

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.lerp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

const val RISE_S = 1.6f      // the picked clover rises and turns gold
const val BURST_S = 2.2f     // then bursts into sparkles
const val RAINBOW_S = 25f    // the rainbow's stay
const val MOTES_S = 20f      // gold motes round the fly

private val CloverGreen = Color(0xFF4F9A36)
private val CloverDark = Color(0xFF2F6A22)
private val Gold = Color(0xFFFFD45A)

/** A cheap repeatable random number in 0..1 for particle [i], channel [k]. */
private fun rnd(i: Int, k: Int): Float {
    val v = sin(i * 12.9898 + k * 78.233) * 43758.5453
    return (v - Math.floor(v)).toFloat()
}

/** A four-leaf clover standing at (x, groundY): its stalk, and four heart leaflets seen a little from above. */
fun DrawScope.drawClover(x: Float, groundY: Float, k: Float, leaf: Color = CloverGreen, spin: Float = 0f) {
    val h = 3.2f * k            // stalk height (mm -> px)
    val r = 1.25f * k           // leaflet size
    val top = Offset(x, groundY - h)
    drawLine(lerp(CloverDark, leaf, 0.3f), Offset(x, groundY), top, strokeWidth = 0.22f * k)
    // seen from the side and a little above: the round of leaflets squashed vertically, spinning about the stalk
    scale(scaleX = 1f, scaleY = 0.45f, pivot = top) {
        for (j in 0 until 4) {
            val a = spin + j * (PI.toFloat() / 2) + PI.toFloat() / 4
            rotate(a * 180f / PI.toFloat(), pivot = top) {
                // a heart: two lobes at the outer end, its point at the centre
                val p = Path().apply {
                    moveTo(top.x, top.y)
                    cubicTo(top.x + r * 0.2f, top.y - r * 0.55f, top.x + r * 0.55f, top.y - r * 1.05f, top.x + r * 0.95f, top.y - r * 0.55f)
                    cubicTo(top.x + r * 1.2f, top.y - r * 0.2f, top.x + r * 1.05f, top.y, top.x + r * 0.9f, top.y)
                    cubicTo(top.x + r * 1.05f, top.y, top.x + r * 1.2f, top.y + r * 0.2f, top.x + r * 0.95f, top.y + r * 0.55f)
                    cubicTo(top.x + r * 0.55f, top.y + r * 1.05f, top.x + r * 0.2f, top.y + r * 0.55f, top.x, top.y)
                    close()
                }
                drawPath(p, leaf)
                // white clover's pale chevron across each leaflet
                drawLine(Color(0x55F4FFE8), Offset(top.x + r * 0.35f, top.y - r * 0.3f), Offset(top.x + r * 0.6f, top.y), strokeWidth = 0.08f * k)
                drawLine(Color(0x55F4FFE8), Offset(top.x + r * 0.35f, top.y + r * 0.3f), Offset(top.x + r * 0.6f, top.y), strokeWidth = 0.08f * k)
            }
        }
    }
}

/** A four-pointed sparkle. */
fun DrawScope.drawSparkle(c: Offset, size: Float, alpha: Float, color: Color = Gold) {
    if (alpha <= 0.01f) return
    drawCircle(color.copy(alpha = 0.35f * alpha), size * 0.8f, c)
    drawCircle(Color.White.copy(alpha = alpha), size * 0.25f, c)
    drawLine(Color.White.copy(alpha = alpha), Offset(c.x - size * 1.4f, c.y), Offset(c.x + size * 1.4f, c.y), strokeWidth = size * 0.18f)
    drawLine(Color.White.copy(alpha = alpha), Offset(c.x, c.y - size * 1.4f), Offset(c.x, c.y + size * 1.4f), strokeWidth = size * 0.18f)
}

/** The rainbow across the sky, behind the scenery (drawn after the far view). */
fun DrawScope.drawRainbow(age: Float) {
    if (age < 0 || age > RAINBOW_S) return
    val a = (age / 3f).coerceIn(0f, 1f) * ((RAINBOW_S - age) / 5f).coerceIn(0f, 1f)
    val colors = listOf(0xFFE8503A, 0xFFF29A38, 0xFFF4E04D, 0xFF5BC25B, 0xFF4E9BE6, 0xFF7A5CD6)
    val w = size.width
    val band = w * 0.028f
    colors.forEachIndexed { i, c ->
        val rr = w * 0.62f - i * band
        drawArc(
            Color(c).copy(alpha = 0.5f * a), 180f, 180f, false,
            Offset(w / 2 - rr, size.height * 0.62f - rr), Size(2 * rr, 2 * rr), style = Stroke(band * 1.05f),
        )
    }
}

/** The picked clover rising and spinning, its burst of sparkles, and gold motes round the fly. */
fun DrawScope.drawLuck(f: Frame, sx: (Double) -> Float, groundY: Float, k: Float, flyX: Float, flyTop: Float) {
    val age = f.luckyAge.toFloat()
    if (age < 0 || age > MOTES_S + 2) return
    val x0 = sx(f.luckyX)
    if (age < RISE_S) {
        val u = age / RISE_S
        val rise = 5f * k * (1 - (1 - u) * (1 - u) * (1 - u))
        val gold = lerp(CloverGreen, Gold, u)
        drawCircle(Gold.copy(alpha = 0.35f * u), 3.5f * k * (0.6f + u), Offset(x0, groundY - 3.2f * k - rise))
        drawClover(x0, groundY - rise, k, gold, spin = age * (3f + 9f * u))
    } else if (age < RISE_S + BURST_S) {
        val t = age - RISE_S
        val origin = Offset(x0, groundY - 3.2f * k - 5f * k)
        for (i in 0 until 36) {
            val ang = rnd(i, 1) * 2 * PI.toFloat()
            val sp = (6f + 14f * rnd(i, 2)) * k
            val drag = (1 - kotlin.math.exp(-1.6f * t)) / 1.6f
            val p = Offset(origin.x + cos(ang) * sp * drag, origin.y + sin(ang) * sp * drag * 0.8f + 9f * k * t * t)
            drawSparkle(p, 0.35f * k * (0.6f + rnd(i, 3)), (1 - t / BURST_S) * (0.6f + 0.4f * sin(t * 30 + i)))
        }
    }
    if (age in 1f..MOTES_S) {
        val fade = ((age - 1f) / 1.5f).coerceIn(0f, 1f) * ((MOTES_S - age) / 3f).coerceIn(0f, 1f)
        for (i in 0 until 26) {
            val life = 2.5f + 3f * rnd(i, 4)
            val ph = ((age + rnd(i, 5) * life) % life) / life           // 0..1 through its fall
            val mx = flyX + (rnd(i, 6) - 0.5f) * 9f * k + sin(age * 2 + i) * 0.4f * k
            val my = flyTop - 4f * k + ph * 9f * k
            drawSparkle(Offset(mx, my), 0.18f * k, fade * sin(ph * PI.toFloat()) * (0.7f + 0.3f * sin(age * 9 + i)))
        }
    }
}

/** The clover in the grass, with a glint every few seconds. */
fun DrawScope.drawLuckyClover(f: Frame, sx: (Double) -> Float, groundY: Float, k: Float) {
    if (!f.cloverShown) return
    val x = sx(f.cloverX)
    if (x < -4 * k || x > size.width + 4 * k) return
    drawClover(x, groundY, k)
    val ph = (f.timeS % 6.5).toFloat()
    if (ph < 0.6f) drawSparkle(Offset(x + 0.6f * k, groundY - 3.6f * k), 0.45f * k, sin(ph / 0.6f * PI.toFloat()))
}

/** Whether a tap at [pos] is on the clover. */
fun cloverHit(f: Frame, pos: Offset, sx: (Double) -> Float, groundY: Float, k: Float): Boolean {
    if (!f.cloverShown) return false
    val x = sx(f.cloverX)
    val reach = maxOf(3f * k, 36f)
    return kotlin.math.abs(pos.x - x) < reach && pos.y > groundY - 6f * k && pos.y < groundY + 2f * k
}
