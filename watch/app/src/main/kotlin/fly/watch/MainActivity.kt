package fly.watch

import android.graphics.BitmapFactory
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import fly.game.Anim
import fly.game.FlyWorld
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {
    private lateinit var engine: GameEngine
    private lateinit var sound: FlySound

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        engine = GameEngine(applicationContext)
        sound = FlySound(applicationContext)
        val sprites = Sprites.load(this)
        val scenery = Scenery.load(this)
        setContent { MaterialTheme { Game(engine, sprites, scenery, sound) } }
    }

    override fun onStart() {
        super.onStart()
        engine.start(lifecycleScope)
        sound.start()
    }

    override fun onStop() {
        engine.stop()
        sound.stop()
        super.onStop()
    }
}

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
private const val SPRITE_MM = 5.98f

private fun viewFor(f: Frame, w: Float, h: Float, flySize: Float): View {
    val k = flySize / SPRITE_MM
    val half = w / 2 / k
    val lim = (FlyWorld.HALF_WIDTH.toFloat() - half).coerceAtLeast(0f)
    val camX = f.x.toFloat().coerceIn(-lim, lim)
    val camZ = (f.z.toFloat() - 2.5f).coerceAtLeast(0f) // follow a flying fly up
    return View(k, camX, camZ, h * STAND_LINE)
}

private val Amber = Color(0xFFE6A84A)
private val EnergyBlue = Color(0xFF7FB6E8)
private val MoodPink = Color(0xFFE88FA8)
private val Ink = Color(0xFFF4EDE2)

@Composable
fun Game(engine: GameEngine, sprites: Sprites, scenery: Scenery, sound: FlySound) {
    val f by engine.frame.collectAsState()
    var info by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    LaunchedEffect(f.anim) {
        if (f.anim == Anim.FLY || f.anim == Anim.FEED) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
    }
    var soundOn by remember { mutableStateOf(sound.enabled) }
    LaunchedEffect(f.anim, soundOn) { // buzz in flight, rub while grooming
        sound.set(wing = if (f.anim == Anim.FLY) 1.0 else 0.0, groom = if (f.anim == Anim.GROOM) 1.0 else 0.0)
    }
    BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black)) {
        val sizePx = constraints.maxWidth.coerceAtMost(constraints.maxHeight).toFloat()
        val flySize = sizePx * 0.46f
        Canvas(
            Modifier.fillMaxSize().pointerInput(Unit) {
                detectTapGestures(onLongPress = { pos ->
                    val cur = engine.frame.value
                    val v = viewFor(cur, size.width.toFloat(), size.height.toFloat(), flySize)
                    val flyPx = size.width / 2f + (cur.x.toFloat() - v.camX) * v.k
                    if (kotlin.math.abs(pos.x - flyPx) < flySize * 0.4f) engine.tickle() // tickle its head
                }) { pos ->
                    val cur = engine.frame.value
                    val v = viewFor(cur, size.width.toFloat(), size.height.toFloat(), flySize)
                    val xMm = v.camX + (pos.x - size.width / 2f) / v.k
                    val flyPx = size.width / 2f + (cur.x.toFloat() - v.camX) * v.k
                    val flyY = v.standY - (cur.z.toFloat() - v.camZ) * v.k - flySize * 0.25f
                    if (kotlin.math.abs(pos.x - flyPx) < flySize * 0.35f && kotlin.math.abs(pos.y - flyY) < flySize * 0.3f) {
                        engine.tap(xMm.toDouble())          // a hand looms in: the brain decides whether to flee
                    } else if (pos.y > v.standY - flySize * 0.2f) {
                        engine.feed(xMm.toDouble())           // tapping the ground drops sugar there
                    }
                }
            },
        ) {
            drawScene(f, sprites, scenery, viewFor(f, size.width, size.height, flySize), flySize)
            drawStats(f)
        }
        f.message?.let {
            Text(
                it, color = Ink, fontSize = 13.sp, textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 58.dp)
                    .background(Color(0x99201A14), RoundedCornerShape(10.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
            )
        }
        if (f.loading) Text("Waking the brain…", color = Ink, modifier = Modifier.align(Alignment.Center))
        // Feed button at the bottom of the round screen; info chip beside it.
        Box(
            Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp).size(52.dp).clip(CircleShape)
                .background(Amber).clickable { engine.feed() },
            contentAlignment = Alignment.Center,
        ) { Text("Feed", color = Color(0xFF2A1C0A), fontWeight = FontWeight.Bold, fontSize = 13.sp) }
        Box(
            Modifier.align(Alignment.BottomCenter).offset(x = 52.dp).padding(bottom = 30.dp).size(30.dp).clip(CircleShape)
                .background(Color(0x99302822)).clickable { info = true },
            contentAlignment = Alignment.Center,
        ) { Text("i", color = Ink, fontWeight = FontWeight.Bold) }
        if (info) InfoPanel(f, soundOn, { soundOn = it; sound.enabled = it }) { info = false }
    }
}

private const val STAND_LINE = 0.71f   // fraction of the screen height where the fly's feet rest
private const val FEET_LINE = 0.756f   // claws' row in the 320 px sprite frames (watch/tools/sprites.html)

/**
 * Draws the on-screen part of a scenery layer. col0 is the layer's column for stage x = 0 and
 * row0 its row for the feet line; it scrolls sideways `rate` times as fast as the stage (all
 * layers move together vertically, so their seams stay joined when the view rises).
 */
private fun DrawScope.drawLayer(img: ImageBitmap, sc: Scenery, v: View, col0: Float, row0: Float, rate: Float) {
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

private fun DrawScope.drawScene(f: Frame, sprites: Sprites, sc: Scenery, v: View, flySize: Float) {
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

/** Food, energy and mood as arcs along the top of the round face. */
private fun DrawScope.drawStats(f: Frame) {
    val stats = listOf(f.satiety to Amber, f.energy to EnergyBlue, f.mood to MoodPink)
    stats.forEachIndexed { k, (v, color) ->
        val inset = 8f + k * 11f
        val arc = Size(size.width - 2 * inset, size.height - 2 * inset)
        val o = Offset(inset, inset)
        drawArc(Color(0x33FFFFFF), 205f, 130f, false, o, arc, style = Stroke(7f, cap = StrokeCap.Round))
        drawArc(color, 205f, 130f * (v / 100.0).toFloat().coerceIn(0.01f, 1f), false, o, arc, style = Stroke(7f, cap = StrokeCap.Round))
    }
}

@Composable
private fun InfoPanel(f: Frame, soundOn: Boolean, setSound: (Boolean) -> Unit, close: () -> Unit) {
    Column(
        Modifier.fillMaxSize().background(Color(0xF0141210)).clickable { close() }
            .verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 30.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("Feed the Fly", color = Amber, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        Text("Day ${f.ageDays}", color = Ink, fontSize = 13.sp)
        Stat("Food", f.satiety, Amber)
        Stat("Energy", f.energy, EnergyBlue)
        Stat("Mood", f.mood, MoodPink)
        Text("Meals ${f.feedings} · Escapes ${f.escapes}", color = Ink, fontSize = 12.sp)
        Text(
            if (soundOn) "Sound on" else "Sound off", color = Color(0xFF2A1C0A), fontSize = 12.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(if (soundOn) Amber else Color(0xFF8A8076))
                .clickable { setSound(!soundOn) }.padding(horizontal = 12.dp, vertical = 4.dp),
        )
        Text("Live neurons", color = Amber, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
        Text(
            "MN9 (proboscis) ${f.mn9.roundToInt()} Hz\nGiant Fiber ${f.gf.roundToInt()} Hz\nP9 walk ${f.p9.roundToInt()} · MDN back ${f.mdn.roundToInt()} Hz\n" +
                "${f.stepping} of 16,540 neurons active\nspeed ${"%.2f".format(f.realtime)}× real time",
            color = Ink, fontSize = 11.sp, textAlign = TextAlign.Center,
        )
        Text(
            "Tap the ground or Feed to drop sugar. A hungry fly's taste neurons drive MN9 and it drinks; a full one refuses. " +
                "Tap the fly and a hand looms in: its Giant Fiber decides whether to flee. " +
                "Long-press it to tickle its head: its head bristles drive the DNg12 grooming neurons, and if they fire it cleans itself.",
            color = Color(0xFFBDB2A2), fontSize = 10.sp, textAlign = TextAlign.Center,
        )
        Text(
            "Brain: 16,540-neuron subcircuit of the MaleCNS v1.0 connectome (Janelia FlyEM, Google Research, Cambridge Connectomics / MRC LMB; CC-BY 4.0), " +
                "neuron model of Shiu et al. 2024. Fly: FlyBody (Vaxenburg, Siwanowicz et al. 2025; Apache-2.0). " +
                "Rigging and leg recordings: NeuroMechFly / flygym (Ramdya lab, EPFL; Apache-2.0).",
            color = Color(0xFF9A8F80), fontSize = 9.sp, textAlign = TextAlign.Center,
        )
        Text("Tap to close", color = Amber, fontSize = 11.sp)
    }
}

@Composable
private fun Stat(label: String, v: Double, color: Color) {
    Column(Modifier.fillMaxWidth(0.8f)) {
        Text("$label ${v.roundToInt()}", color = Ink, fontSize = 11.sp)
        Box(Modifier.fillMaxWidth().padding(top = 2.dp).height(5.dp).clip(RoundedCornerShape(3.dp)).background(Color(0x33FFFFFF))) {
            Box(Modifier.fillMaxWidth((v / 100).toFloat().coerceIn(0f, 1f)).height(5.dp).background(color))
        }
    }
}
