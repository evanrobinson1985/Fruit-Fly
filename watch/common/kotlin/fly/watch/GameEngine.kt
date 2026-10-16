package fly.watch

import android.content.Context
import fly.brain.Connectome
import fly.brain.WebConnectome
import fly.game.Anim
import fly.game.FlyWorld
import fly.game.Pet
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.Calendar
import java.util.concurrent.ConcurrentLinkedQueue

/** What the screen draws, copied from the world after every brain step. */
data class Frame(
    val x: Double = 0.0, val z: Double = 0.0, val facing: Int = 1, val anim: Anim = Anim.IDLE,
    val animTime: Double = 0.0, val walkPhase: Double = 0.0, val proboscis: Double = 0.0,
    val food: List<Pair<Double, Double>> = emptyList(), val message: String? = null,
    val satiety: Double = 0.0, val energy: Double = 0.0, val mood: Double = 0.0,
    val ageDays: Int = 1, val feedings: Int = 0, val escapes: Int = 0,
    val mn9: Double = 0.0, val gf: Double = 0.0, val p9: Double = 0.0, val mdn: Double = 0.0,
    val stepping: Int = 0, val realtime: Double = 1.0, val night: Boolean = false, val loading: Boolean = true,
    val neurons: Int = 0, val droppings: List<Double> = emptyList(),
)

/**
 * Owns the connectome circuit, the world and the pet; runs the brain on a background thread.
 * [fullBrain]: load the website's whole-CNS connectome from assets/full (the phone app)
 * instead of the watch circuit.
 */
class GameEngine(private val context: Context, private val fullBrain: Boolean = false) {
    private val store = PetStore(context)
    private var world: FlyWorld? = null
    private var job: Job? = null
    private val commands = ConcurrentLinkedQueue<(FlyWorld) -> Unit>()
    private val _frame = MutableStateFlow(Frame())
    val frame: StateFlow<Frame> = _frame

    /** Drop sugar at a stage position, or (Feed button) a little ahead of the fly, where it can be seen. */
    fun feed(atX: Double? = null) = commands.add { it.dropFood(atX ?: (it.x + it.facing * (2.5 + 2.5 * Math.random()))) }

    /** Tap at a stage position (mm): a hand looms in from that side. */
    fun tap(xMm: Double) = commands.add { it.tap(xMm) }

    /** Long-press on the fly: tickle its head. */
    fun tickle() = commands.add { it.tickle() }

    /** Clean up the droppings. */
    fun clean() = commands.add { it.clean() }

    fun start(scope: CoroutineScope) {
        if (job != null) return
        job = scope.launch(Dispatchers.Default) {
            val w = world ?: load().also { world = it }
            val now = System.currentTimeMillis()
            val away = now - w.pet.updatedAtMs
            w.pet.advance(now, asleepFraction = nightFraction(w.pet.updatedAtMs, now))
            // Food eaten before the app closed has since passed through: droppings wait on the stage.
            if (away > 120_000) repeat(w.pet.digestAway()) {
                if (w.pet.droppings.size < FlyWorld.MAX_DROPPINGS) w.pet.droppings += (Math.random() - 0.5) * 2 * (FlyWorld.HALF_WIDTH - 3)
            }
            var lastSave = now
            var wallPerStep = FlyWorld.STEP_MS.toDouble()
            while (isActive) {
                val t0 = System.nanoTime()
                while (true) commands.poll()?.invoke(w) ?: break
                w.setAsleep(isNight() || w.pet.energy < 12)
                w.step()
                val wall = (System.nanoTime() - t0) / 1e6
                wallPerStep = wallPerStep * 0.95 + wall * 0.05
                publish(w, FlyWorld.STEP_MS / wallPerStep)
                // Pace to real time; when the watch is slower, run as fast as it can.
                val sleep = FlyWorld.STEP_MS - wall
                if (sleep > 1) delay(sleep.toLong())
                val t = System.currentTimeMillis()
                w.pet.updatedAtMs = t
                if (t - lastSave > 10_000) { store.save(w.pet); lastSave = t }
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        world?.let { store.save(it.pet.also { p -> p.updatedAtMs = System.currentTimeMillis() }) }
    }

    private fun load(): FlyWorld {
        val c = if (fullBrain) WebConnectome.read { name -> context.assets.open("full/$name") }
        else context.assets.open("brain.bin").use { bin -> context.assets.open("brain.txt").use { txt -> Connectome.read(bin, txt) } }
        return FlyWorld(c, store.load(), seed = (System.currentTimeMillis() % 100000).toInt())
    }

    private fun publish(w: FlyWorld, realtime: Double) {
        val p = w.pet
        _frame.value = Frame(
            x = w.x, z = w.z, facing = w.facing, anim = w.anim, animTime = w.animTime, walkPhase = w.walkPhase,
            proboscis = w.proboscis, food = w.food.filter { it.amount > 0 }.map { it.x to it.amount },
            message = w.message, satiety = p.satiety, energy = p.energy, mood = p.mood,
            ageDays = p.ageDays(System.currentTimeMillis()), feedings = p.feedings, escapes = p.escapes,
            mn9 = w.motor["feed"]!!, gf = w.motor["escape"]!!, p9 = w.motor["forward"]!!, mdn = w.motor["backward"]!!,
            stepping = w.brain.stepping, realtime = realtime.coerceAtMost(1.0), night = isNight(), loading = false,
            neurons = w.brain.n, droppings = w.pet.droppings.toList(),
        )
    }

    companion object {
        /** Flies sleep mostly at night: 22:00 to 07:00 local time. */
        fun isNight(cal: Calendar = Calendar.getInstance()): Boolean {
            val h = cal.get(Calendar.HOUR_OF_DAY)
            return h >= 22 || h < 7
        }

        /** Share of the interval [from, to] that fell at night, sampled every 15 minutes. */
        fun nightFraction(from: Long, to: Long): Double {
            if (to <= from) return 0.0
            val cal = Calendar.getInstance()
            var t = from
            var night = 0
            var total = 0
            while (t < to) {
                cal.timeInMillis = t
                if (isNight(cal)) night++
                total++
                t += 15 * 60_000L
            }
            return night.toDouble() / total
        }
    }
}

/** Saves the pet between sessions. */
class PetStore(context: Context) {
    private val prefs = context.getSharedPreferences("pet", Context.MODE_PRIVATE)

    fun load(): Pet {
        if (!prefs.contains("bornAt")) return Pet.newborn(System.currentTimeMillis())
        return Pet(
            satiety = prefs.getFloat("satiety", 70f).toDouble(), energy = prefs.getFloat("energy", 80f).toDouble(),
            mood = prefs.getFloat("mood", 60f).toDouble(), bornAtMs = prefs.getLong("bornAt", 0L),
            updatedAtMs = prefs.getLong("updatedAt", 0L), feedings = prefs.getInt("feedings", 0),
            escapes = prefs.getInt("escapes", 0), cleans = prefs.getInt("cleans", 0),
            gut = prefs.getFloat("gut", 0f).toDouble(),
            droppings = prefs.getString("droppings", "")!!.split(",").mapNotNull { it.toDoubleOrNull() }.toMutableList(),
        )
    }

    fun save(p: Pet) {
        prefs.edit()
            .putFloat("satiety", p.satiety.toFloat()).putFloat("energy", p.energy.toFloat()).putFloat("mood", p.mood.toFloat())
            .putLong("bornAt", p.bornAtMs).putLong("updatedAt", p.updatedAtMs)
            .putInt("feedings", p.feedings).putInt("escapes", p.escapes).putInt("cleans", p.cleans)
            .putFloat("gut", p.gut.toFloat()).putString("droppings", p.droppings.joinToString(",") { "%.2f".format(java.util.Locale.ROOT, it) })
            .apply()
    }
}
