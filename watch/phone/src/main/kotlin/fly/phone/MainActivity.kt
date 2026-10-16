package fly.phone

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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import fly.game.Anim
import fly.watch.Amber
import fly.watch.EnergyBlue
import fly.watch.FlySound
import fly.watch.Frame
import fly.watch.GameEngine
import fly.watch.Ink
import fly.watch.MoodPink
import fly.watch.SPRITE_MM
import fly.watch.Scenery
import fly.watch.Sprites
import fly.watch.drawScene
import fly.watch.viewFor
import kotlin.math.roundToInt

/** Feed the Fly on a phone: the same pet, brain and arena as the watch, in portrait. */
class MainActivity : ComponentActivity() {
    private lateinit var engine: GameEngine
    private lateinit var sound: FlySound

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        engine = GameEngine(applicationContext)
        sound = FlySound(applicationContext)
        val sprites = Sprites.load(this)
        val scenery = Scenery.load(this)
        setContent { PhoneGame(engine, sprites, scenery, sound) }
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

private val Bg = Color(0xFF141210)
private val Panel = Color(0xFF221E1A)
private val Dim = Color(0xFFBDB2A2)

// The scene shows VIEW_MM of the stage across the screen, with the fly's feet this far down.
private const val VIEW_MM = 19f
private const val STAND = 0.78f

@Composable
fun PhoneGame(engine: GameEngine, sprites: Sprites, scenery: Scenery, sound: FlySound) {
    val f by engine.frame.collectAsState()
    var help by remember { mutableStateOf(false) }
    var soundOn by remember { mutableStateOf(sound.enabled) }
    val haptics = LocalHapticFeedback.current
    LaunchedEffect(f.anim) {
        if (f.anim == Anim.FLY || f.anim == Anim.FEED) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
    }
    LaunchedEffect(f.anim, soundOn) {
        sound.set(wing = if (f.anim == Anim.FLY) 1.0 else 0.0, groom = if (f.anim == Anim.GROOM) 1.0 else 0.0)
    }
    Column(
        Modifier.fillMaxSize().background(Bg).safeDrawingPadding().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Title, age and sound.
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Feed the Fly", color = Amber, fontWeight = FontWeight.Bold, fontSize = 22.sp)
                Text("Dot · day ${f.ageDays} · ${f.feedings} meals · ${f.escapes} escapes", color = Dim, fontSize = 13.sp)
            }
            Chip(if (soundOn) "Sound on" else "Sound off", if (soundOn) Amber else Color(0xFF8A8076)) {
                soundOn = !soundOn
                sound.enabled = soundOn
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Bar("Food", f.satiety, Amber, Modifier.weight(1f))
            Bar("Energy", f.energy, EnergyBlue, Modifier.weight(1f))
            Bar("Mood", f.mood, MoodPink, Modifier.weight(1f))
        }
        Scene(f, engine, sprites, scenery)
        // Buttons.
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            BigButton("Feed", Amber, Color(0xFF2A1C0A), Modifier.weight(1f)) { engine.feed() }
            BigButton("Tickle", Color(0xFF3A332C), Ink, Modifier.weight(1f)) { engine.tickle() }
            BigButton(if (help) "Close" else "How to play", Color(0xFF3A332C), Ink, Modifier.weight(1f)) { help = !help }
        }
        if (help) Help()
        Neurons(f)
        Spacer(Modifier.height(12.dp))
    }
}

@Composable
private fun Scene(f: Frame, engine: GameEngine, sprites: Sprites, scenery: Scenery) {
    BoxWithConstraints(Modifier.fillMaxWidth().aspectRatio(1f).background(Color.Black)) {
        val w = constraints.maxWidth.toFloat()
        val flySize = w / VIEW_MM * SPRITE_MM
        Canvas(
            Modifier.fillMaxSize().pointerInput(Unit) {
                detectTapGestures(onLongPress = { pos ->
                    val cur = engine.frame.value
                    val v = viewFor(cur, size.width.toFloat(), size.height.toFloat(), flySize, STAND)
                    val flyPx = size.width / 2f + (cur.x.toFloat() - v.camX) * v.k
                    if (kotlin.math.abs(pos.x - flyPx) < flySize * 0.4f) engine.tickle()
                }) { pos ->
                    val cur = engine.frame.value
                    val v = viewFor(cur, size.width.toFloat(), size.height.toFloat(), flySize, STAND)
                    val xMm = v.camX + (pos.x - size.width / 2f) / v.k
                    val flyPx = size.width / 2f + (cur.x.toFloat() - v.camX) * v.k
                    val flyY = v.standY - (cur.z.toFloat() - v.camZ) * v.k - flySize * 0.25f
                    if (kotlin.math.abs(pos.x - flyPx) < flySize * 0.35f && kotlin.math.abs(pos.y - flyY) < flySize * 0.3f) {
                        engine.tap(xMm.toDouble())      // a hand looms in: the brain decides whether to flee
                    } else if (pos.y > v.standY - flySize * 0.2f) {
                        engine.feed(xMm.toDouble())     // tapping the ground drops sugar there
                    }
                }
            },
        ) {
            drawScene(f, sprites, scenery, viewFor(f, size.width, size.height, flySize, STAND), flySize)
        }
        f.message?.let {
            Text(
                it, color = Ink, fontSize = 16.sp, textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 16.dp)
                    .background(Color(0x99201A14), RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 5.dp),
            )
        }
        if (f.loading) Text("Waking the brain…", color = Ink, fontSize = 18.sp, modifier = Modifier.align(Alignment.Center))
        if (f.night && !f.loading) {
            Text("Night: Dot is asleep until 7:00", color = Dim, fontSize = 13.sp,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp))
        }
    }
}

@Composable
private fun Bar(label: String, v: Double, color: Color, modifier: Modifier) {
    Column(modifier) {
        Text("$label ${v.roundToInt()}", color = Ink, fontSize = 13.sp)
        Box(Modifier.fillMaxWidth().padding(top = 4.dp).height(8.dp).clip(RoundedCornerShape(4.dp)).background(Color(0x33FFFFFF))) {
            Box(Modifier.fillMaxWidth((v / 100).toFloat().coerceIn(0f, 1f)).height(8.dp).background(color))
        }
    }
}

@Composable
private fun BigButton(label: String, bg: Color, fg: Color, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier.height(56.dp).clip(RoundedCornerShape(16.dp)).background(bg).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = fg, fontWeight = FontWeight.Bold, fontSize = 16.sp) }
}

@Composable
private fun Chip(label: String, bg: Color, onClick: () -> Unit) {
    Text(
        label, color = Color(0xFF2A1C0A), fontSize = 13.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier.clip(RoundedCornerShape(14.dp)).background(bg).clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 6.dp),
    )
}

/** Live readout of the neurons that drive what the fly does. */
@Composable
private fun Neurons(f: Frame) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp).clip(RoundedCornerShape(16.dp)).background(Panel).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("Live neurons", color = Amber, fontWeight = FontWeight.Bold, fontSize = 15.sp)
        Rate("MN9 · proboscis (drinking)", f.mn9, 60.0)
        Rate("Giant Fiber · escape", f.gf, 300.0)
        Rate("P9 · walk forward", f.p9, 60.0)
        Rate("MDN · walk backward", f.mdn, 60.0)
        Text(
            "${f.stepping} of 16,540 neurons active · ${"%.2f".format(f.realtime)}× real time",
            color = Dim, fontSize = 12.sp,
        )
    }
}

@Composable
private fun Rate(label: String, hz: Double, max: Double) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Ink, fontSize = 13.sp, modifier = Modifier.weight(1f))
        Box(Modifier.width(90.dp).height(6.dp).clip(RoundedCornerShape(3.dp)).background(Color(0x33FFFFFF))) {
            Box(Modifier.fillMaxWidth((hz / max).toFloat().coerceIn(0f, 1f)).height(6.dp).background(Amber))
        }
        Text("${hz.roundToInt()} Hz", color = Dim, fontSize = 12.sp, textAlign = TextAlign.End, modifier = Modifier.width(56.dp))
    }
}

@Composable
private fun Help() {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp).clip(RoundedCornerShape(16.dp)).background(Panel).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("How to play", color = Amber, fontWeight = FontWeight.Bold, fontSize = 15.sp)
        Text(
            "Dot is a fruit fly whose choices come from a 16,540-neuron circuit of a real fly's mapped " +
                "nervous system. Keep it fed, rested and happy.\n\n" +
                "• Tap the grass or press Feed to drop sugar. A hungry fly's taste neurons drive MN9 and it " +
                "drinks; a full one refuses.\n" +
                "• Tap the fly and a hand looms in: its Giant Fiber decides whether to flee. Now and then is " +
                "exercise; chasing it all the time stresses it.\n" +
                "• Long-press the fly (or press Tickle) to touch its head: its grooming neurons may make it " +
                "clean itself.\n" +
                "• It gets hungry over hours and sleeps at night (22:00 to 7:00), even while the app is closed.",
            color = Ink, fontSize = 14.sp,
        )
        Text(
            "Brain: MaleCNS v1.0 connectome (Janelia FlyEM, Google Research, Cambridge Connectomics / MRC LMB; " +
                "CC-BY 4.0), neuron model of Shiu et al. 2024. Fly: FlyBody (Vaxenburg, Siwanowicz et al. 2025; " +
                "Apache-2.0). Rigging and leg recordings: NeuroMechFly / flygym (Ramdya lab, EPFL; Apache-2.0).",
            color = Color(0xFF9A8F80), fontSize = 11.sp,
        )
    }
}
