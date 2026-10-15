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
import androidx.compose.ui.graphics.Brush
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
import kotlin.random.Random

class MainActivity : ComponentActivity() {
    private lateinit var engine: GameEngine

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        engine = GameEngine(applicationContext)
        val sprites = Sprites.load(this)
        setContent { MaterialTheme { Game(engine, sprites) } }
    }

    override fun onStart() {
        super.onStart()
        engine.start(lifecycleScope)
    }

    override fun onStop() {
        engine.stop()
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

private val Amber = Color(0xFFE6A84A)
private val EnergyBlue = Color(0xFF7FB6E8)
private val MoodPink = Color(0xFFE88FA8)
private val Ink = Color(0xFFF4EDE2)

@Composable
fun Game(engine: GameEngine, sprites: Sprites) {
    val f by engine.frame.collectAsState()
    var info by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    LaunchedEffect(f.anim) {
        if (f.anim == Anim.FLY || f.anim == Anim.FEED) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
    }
    BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black)) {
        val sizePx = constraints.maxWidth.coerceAtMost(constraints.maxHeight).toFloat()
        val scale = sizePx * 0.40f / FlyWorld.HALF_WIDTH.toFloat() // px per mm of stage
        val groundY = sizePx * 0.68f
        val flySize = sizePx * 0.46f
        Canvas(
            Modifier.fillMaxSize().pointerInput(Unit) {
                detectTapGestures { pos ->
                    val cur = engine.frame.value
                    val xMm = (pos.x - size.width / 2f) / scale
                    val flyPx = size.width / 2f + cur.x.toFloat() * scale
                    val flyY = groundY + size.height * STAND_DEPTH - cur.z.toFloat() * scale - flySize * 0.25f
                    if (kotlin.math.abs(pos.x - flyPx) < flySize * 0.35f && kotlin.math.abs(pos.y - flyY) < flySize * 0.3f) {
                        engine.tap(xMm.toDouble())          // a hand looms in: the brain decides whether to flee
                    } else if (pos.y > groundY - 10) {
                        engine.feed()                         // tapping the ground drops sugar too
                    }
                }
            },
        ) {
            drawScene(f, sprites, scale, groundY, flySize)
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
        if (info) InfoPanel(f) { info = false }
    }
}

private const val STAND_DEPTH = 0.035f // fraction of the screen below the horizon where feet rest
private const val FEET_LINE = 0.756f   // claws' row in the 320 px sprite frames (watch/tools/sprites.html)

private val stars = List(40) { Offset(Random(it).nextFloat(), Random(it + 99).nextFloat() * 0.6f) }
private val tufts = List(70) { Triple(Random(it * 7).nextFloat(), Random(it * 13).nextFloat(), Random(it * 3).nextFloat()) }

private fun DrawScope.drawScene(f: Frame, sprites: Sprites, scale: Float, groundY: Float, flySize: Float) {
    val w = size.width
    val h = size.height
    // Sky by time of day, then the ground with grass tufts.
    val sky = if (f.night) listOf(Color(0xFF0B1328), Color(0xFF1E2C4E)) else listOf(Color(0xFF9FD3EA), Color(0xFFF2E6C8))
    drawRect(Brush.verticalGradient(sky, endY = groundY), size = Size(w, groundY))
    if (f.night) stars.forEach { drawCircle(Color(0xCCFFFFFF), 1.6f, Offset(it.x * w, it.y * groundY)) }
    drawRect(Brush.verticalGradient(listOf(Color(0xFF4F7A33), Color(0xFF2C431E)), startY = groundY, endY = h), Offset(0f, groundY), Size(w, h - groundY))
    tufts.forEach { (tx, ty, th) ->
        val bx = tx * w
        val by = groundY + ty * (h - groundY) * 0.5f
        val len = 6f + th * 14f
        drawLine(Color(0xFF6E9E45), Offset(bx, by), Offset(bx - 3f, by - len), 2f, StrokeCap.Round)
        drawLine(Color(0xFF5C8A3A), Offset(bx + 3f, by), Offset(bx + 6f, by - len * 0.8f), 2f, StrokeCap.Round)
    }
    // Things stand a little into the grass strip, not on the horizon line.
    val standY = groundY + h * STAND_DEPTH
    // Sugar drops: size shows how much is left.
    for ((fx, amount) in f.food) {
        val cx = w / 2 + fx.toFloat() * scale
        val r = 7f + 9f * (amount / 30.0).toFloat()
        drawOval(Color(0xFFD9A441), Offset(cx - r, standY - r * 0.55f), Size(2 * r, r * 0.9f))
        drawOval(Color(0x99FFF4D6), Offset(cx - r * 0.45f, standY - r * 0.45f), Size(r * 0.5f, r * 0.25f))
    }
    // The fly: its claws are FEET_LINE of the way down each sprite frame.
    val img = sprites.pick(f)
    val px = w / 2 + f.x.toFloat() * scale
    val top = standY - f.z.toFloat() * scale - flySize * FEET_LINE
    drawOval(Color(0x33000000), Offset(px - flySize * 0.22f, standY - 3f), Size(flySize * 0.44f, 7f))
    scale(scaleX = f.facing.toFloat(), scaleY = 1f, pivot = Offset(px, top + flySize / 2)) {
        drawImage(
            img, dstOffset = IntOffset((px - flySize / 2).toInt(), top.toInt()),
            dstSize = IntSize(flySize.toInt(), flySize.toInt()),
        )
    }
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
private fun InfoPanel(f: Frame, close: () -> Unit) {
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
        Text("Live neurons", color = Amber, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
        Text(
            "MN9 (proboscis) ${f.mn9.roundToInt()} Hz\nGiant Fiber ${f.gf.roundToInt()} Hz\nP9 walk ${f.p9.roundToInt()} · MDN back ${f.mdn.roundToInt()} Hz\n" +
                "${f.stepping} of 15,154 neurons active\nspeed ${"%.2f".format(f.realtime)}× real time",
            color = Ink, fontSize = 11.sp, textAlign = TextAlign.Center,
        )
        Text(
            "Tap the ground or Feed to drop sugar. A hungry fly's taste neurons drive MN9 and it drinks; a full one refuses. " +
                "Tap the fly and a hand looms in: its Giant Fiber decides whether to flee.",
            color = Color(0xFFBDB2A2), fontSize = 10.sp, textAlign = TextAlign.Center,
        )
        Text(
            "Brain: 15,154-neuron subcircuit of the MaleCNS v1.0 connectome (Janelia FlyEM, Google Research, Cambridge Connectomics / MRC LMB; CC-BY 4.0), " +
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
