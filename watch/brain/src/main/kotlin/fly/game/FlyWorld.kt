package fly.game

import fly.brain.Brain
import fly.brain.Connectome
import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sign
import kotlin.random.Random

enum class Anim { IDLE, WALK, FEED, FLY, SLEEP }

/** A sugar drop on the ground. Units: mm along the stage. */
data class Food(val x: Double, var amount: Double = 30.0, var ignoredUntil: Double = 0.0)

/** A looming hand/shadow approaching from one side; the eye on that side sees it. */
private data class Loom(val fromLeft: Boolean, val t0: Double) {
    // A 25 mm "hand" approaching at 300 mm/s from 150 mm away.
    fun expansionDegPerS(t: Double): Double? {
        val d = 150.0 - 300.0 * (t - t0)
        if (t < t0 || d <= 12.5) return null
        return Math.toDegrees(2 * 12.5 * 300.0 / (d * d + 12.5 * 12.5))
    }
}

/**
 * The closed loop for Feed the Fly: a side-view stage, the pet's body, and the
 * connectome circuit. Every [STEP_MS] the world sets sensory firing rates, runs
 * the brain, and turns descending/motor neuron rates into behavior:
 *
 *  - taste neurons (recruited by hunger) -> MN9 -> proboscis extension -> eating
 *  - looming on one eye -> LC4/LPLC2 -> Giant Fiber -> takeoff
 *  - P9 / MDN / DNa -> walking speed, backing up, turning around
 *
 * Walking toward food and wandering are body-level behaviors (the circuit has no
 * validated odor-steering), as in the browser version.
 */
class FlyWorld(private val c: Connectome, val pet: Pet, seed: Int = 1) {
    val brain = Brain(c, seed)
    private val rng = Random(seed)
    private val counts = IntArray(c.n)

    // Stage: x in mm, 0 at screen center; the ground is visible for |x| < HALF_WIDTH.
    var x = 0.0; private set
    var facing = 1; private set           // +1 right, -1 left
    var z = 0.0; private set              // height while flying, mm
    var anim = Anim.IDLE; private set
    var animTime = 0.0; private set       // seconds in the current animation
    var proboscis = 0.0; private set      // 0..1, drives the feed frames
    var speed = 0.0; private set
    var walkPhase = 0.0; private set      // step cycles walked, drives the walk frames
    var message: String? = null; private set
    var messageUntil = 0.0; private set
    val food = mutableListOf<Food>()
    var asleep = false; private set
    var timeS = 0.0; private set

    /** Smoothed motor-group rates (Hz), max over sides. */
    val motor = mutableMapOf("forward" to 0.0, "backward" to 0.0, "turn" to 0.0, "escape" to 0.0, "feed" to 0.0)
    val turnLR = doubleArrayOf(0.0, 0.0)

    private var loom: Loom? = null
    private var flightLeft = 0.0
    private var flightTarget = 0.0
    private var boutLeft = 0.0
    private var tasteSince = -1.0
    private var tasteIdx = IntArray(0)
    private var wanderTarget = 0.0
    private var pauseLeft = 0.0
    private val escapeTimes = ArrayDeque<Double>()
    private var lastInputs = ""

    fun dropFood(atX: Double = (rng.nextDouble() - 0.5) * 2 * (HALF_WIDTH - 6)) {
        food.removeAll { it.amount <= 0 }
        if (food.size >= 3) food.removeAt(0)
        food += Food(atX.coerceIn(-HALF_WIDTH + 4, HALF_WIDTH - 4))
        if (asleep) say("Zzz…")
    }

    /** A tap near the fly: a hand looms in from the side of the tap. */
    fun tap(atX: Double) {
        if (loom != null || anim == Anim.FLY) return
        loom = Loom(fromLeft = atX < x, t0 = timeS)
    }

    fun setAsleep(value: Boolean) {
        if (value == asleep) return
        asleep = value
        say(if (value) "Zzz…" else "Awake!")
    }

    private fun say(text: String, seconds: Double = 2.0) {
        message = text
        messageUntil = timeS + seconds
    }

    /** Advance one brain/body exchange interval. */
    fun step() {
        val dt = STEP_MS / 1000.0
        timeS += dt
        if (timeS > messageUntil) message = null

        // ---------- senses -> firing rates ----------
        val onFood = food.firstOrNull { abs(it.x - x) < FOOD_RADIUS && it.amount > 0 && z == 0.0 }
        if (onFood != null && timeS >= onFood.ignoredUntil) {
            if (tasteSince < 0) {
                tasteSince = timeS
                // Which sugar neurons respond on this contact depends on hunger.
                val all = c.group("taste")
                tasteIdx = all.toList().shuffled(rng).take(pet.tasteRecruitment()).toIntArray()
            }
        } else tasteSince = -1.0
        var loomL = 0.0
        var loomR = 0.0
        loom?.let { lo ->
            val e = lo.expansionDegPerS(timeS)
            if (e == null) loom = null else {
                // Sleeping flies are less responsive to visual threats.
                val gain = if (asleep) 0.5 else 1.0
                val r = gain * LOOM_MAX_HZ * (1 - exp(-e / LOOM_REF))
                // A hand from the fly's left is seen by its left eye when facing right, etc.
                val leftEye = lo.fromLeft == (facing > 0)
                if (leftEye) loomL = r else loomR = r
            }
        }
        val tasteHz = if (tasteSince >= 0) TASTE_HZ else 0.0
        val key = "$tasteHz ${tasteIdx.size} $loomL $loomR"
        if (key != lastInputs) {
            lastInputs = key
            brain.clearRates()
            if (tasteHz > 0) brain.setRates(tasteIdx, tasteHz)
            if (loomL > 0) brain.setRates(c.group("loom.L"), loomL)
            if (loomR > 0) brain.setRates(c.group("loom.R"), loomR)
        }

        // ---------- brain ----------
        counts.fill(0)
        brain.run(STEP_MS.toDouble(), counts)
        val a = min(1.0, STEP_MS / SMOOTH_MS)
        for (g in motor.keys.toList()) {
            val r = listOf("L", "R").map { s -> c.group("motor.$g.$s").let { idx -> if (idx.isEmpty()) 0.0 else idx.sumOf { counts[it] } / idx.size.toDouble() / dt } }
            if (g == "turn") { turnLR[0] += a * (r[0] - turnLR[0]); turnLR[1] += a * (r[1] - turnLR[1]) }
            motor[g] = motor[g]!! + a * (max(r[0], r[1]) - motor[g]!!)
        }

        // ---------- body ----------
        animTime += dt
        if (anim == Anim.FLY) return fly(dt)
        if (motor["escape"]!! > ESCAPE_HZ) return takeoff()
        // A starving fly lies still until food appears, then crawls to it.
        val anyFood = food.any { it.amount > 0 }
        if (pet.weak && !anyFood) return setAnim(Anim.SLEEP).also { if (rng.nextDouble() < 0.002) say("So hungry…") }

        // Feeding: MN9 above threshold extends the proboscis and starts a feeding bout.
        if (onFood != null && motor["feed"]!! > FEED_HZ && boutLeft <= 0) {
            boutLeft = BOUT_S
            pet.boutStarted()
            if (asleep) setAsleep(false)
        }
        if (onFood != null && boutLeft > 0) {
            boutLeft -= dt
            proboscis = min(1.0, proboscis + dt / 0.15)
            val bite = min(onFood.amount, BITE_PER_S * dt)
            onFood.amount -= bite
            pet.ate(bite)
            if (boutLeft <= 0 || onFood.amount <= 0) {
                tasteSince = -1.0 // next contact recruits a fresh set of taste neurons
                if (onFood.amount <= 0) say("Yum!")
            }
            speed = 0.0
            return setAnim(Anim.FEED)
        }
        proboscis = max(0.0, proboscis - dt / 0.2)
        // Tasted for a while without an MN9 response: not hungry, walk away.
        if (onFood != null && tasteSince >= 0 && timeS - tasteSince > REFUSE_AFTER_S) {
            onFood.ignoredUntil = timeS + 25.0
            tasteSince = -1.0
            say("Not hungry")
            wanderTarget = x - sign(onFood.x - x + 1e-6) * 15
        }
        if (asleep && !pet.weak) { speed = 0.0; return setAnim(Anim.SLEEP) }

        // Wander or approach food (body-level), modulated by P9 (forward) and MDN (backward).
        val target = food.filter { it.amount > 0 && timeS >= it.ignoredUntil && pet.satiety < 95 }.minByOrNull { abs(it.x - x) }
        val goal = target?.x ?: wanderTarget
        if (target == null && (abs(goal - x) < 1 || pauseLeft > 0)) {
            if (pauseLeft <= 0) pauseLeft = 1.0 + rng.nextDouble() * 4
            pauseLeft -= dt
            if (pauseLeft <= 0) wanderTarget = (rng.nextDouble() - 0.5) * 2 * (HALF_WIDTH - 5)
            speed = 0.0
        } else if (abs(goal - x) > 0.4) {
            facing = if (goal > x) 1 else -1
        }
        val moving = target != null && abs(goal - x) > 0.4 || target == null && pauseLeft <= 0 && abs(goal - x) >= 1
        val vigor = if (pet.weak) 0.3 else 0.5 + pet.energy / 200
        val base = if (moving) BASE_SPEED * vigor else 0.0
        val cmd = base + FWD_GAIN * motor["forward"]!! - BACK_GAIN * motor["backward"]!!
        speed += (cmd - speed) * min(1.0, dt / 0.1)
        // Strong one-sided DNa activity turns the fly around.
        if (abs(turnLR[0] - turnLR[1]) > TURN_HZ) facing = if (turnLR[0] > turnLR[1]) -1 else 1
        x = (x + facing * speed * dt).coerceIn(-HALF_WIDTH + 2, HALF_WIDTH - 2)
        walkPhase += speed * dt / STRIDE_MM
        setAnim(if (abs(speed) > 0.3) Anim.WALK else Anim.IDLE)
    }

    private fun takeoff() {
        loom = null
        escapeTimes.addLast(timeS)
        while (escapeTimes.isNotEmpty() && escapeTimes.first() < timeS - 60) escapeTimes.removeFirst()
        pet.escaped(escapeTimes.size)
        if (asleep) setAsleep(false)
        boutLeft = 0.0
        tasteSince = -1.0
        flightLeft = 0.8 + rng.nextDouble() * 0.6
        flightTarget = (rng.nextDouble() - 0.5) * 2 * (HALF_WIDTH - 6)
        facing = if (flightTarget > x) 1 else -1
        say(if (escapeTimes.size > 2) "Leave me alone!" else "Whoosh!", 1.5)
        setAnim(Anim.FLY)
    }

    private fun fly(dt: Double) {
        flightLeft -= dt
        val total = max(0.2, flightLeft + animTime)
        val f = (animTime / total).coerceIn(0.0, 1.0)
        x += (flightTarget - x) * min(1.0, dt * 3)
        z = 18 * Math.sin(Math.PI * f)
        if (flightLeft <= 0) { z = 0.0; setAnim(Anim.IDLE) }
    }

    private fun setAnim(a: Anim) {
        if (a != anim) { anim = a; animTime = 0.0 }
    }

    companion object {
        const val STEP_MS = 20
        const val SMOOTH_MS = 60.0
        const val HALF_WIDTH = 30.0       // mm of ground visible either side of center
        const val FOOD_RADIUS = 2.0
        const val TASTE_HZ = 40.0
        const val LOOM_MAX_HZ = 150.0
        const val LOOM_REF = 1000.0
        const val ESCAPE_HZ = 50.0
        const val FEED_HZ = 20.0
        const val BOUT_S = 1.2
        const val BITE_PER_S = 6.0        // satiety points per second of drinking
        const val REFUSE_AFTER_S = 2.0
        const val BASE_SPEED = 6.0        // mm/s
        const val FWD_GAIN = 0.25
        const val BACK_GAIN = 0.3
        const val TURN_HZ = 25.0
        const val STRIDE_MM = 1.6
    }
}
