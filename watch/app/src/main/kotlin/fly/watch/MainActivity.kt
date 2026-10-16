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
        // Droppings to clean: a chip on the other side of Feed.
        if (f.droppings.isNotEmpty()) Box(
            Modifier.align(Alignment.BottomCenter).offset(x = (-52).dp).padding(bottom = 30.dp).size(30.dp).clip(CircleShape)
                .background(Color(0xCC6E4A22)).clickable { engine.clean() },
            contentAlignment = Alignment.Center,
        ) { Text("${f.droppings.size}", color = Ink, fontWeight = FontWeight.Bold, fontSize = 12.sp) }
        if (info) InfoPanel(f, soundOn, { soundOn = it; sound.enabled = it }) { info = false }
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
                "Long-press it to tickle its head: its head bristles drive the DNg12 grooming neurons, and if they fire it cleans itself. " +
                "What it drinks passes through its gut and comes out as tiny droplets; tap the brown chip to clean them up, or its mood sours.",
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
