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

enum class Anim { IDLE, WALK, FEED, FLY, SLEEP, GROOM, POOP }

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
 *  - head bristles (a tickle, sugar on the face, dust) -> DNg12 -> grooming
 *
 * What it drinks passes through its gut and leaves as small droplets: the fly pauses, dips
 * the tip of its abdomen and deposits one (body-level, as on the website: web/src/world.js).
 *
 * Walking toward food is a body-level behavior (the circuit has no validated odor
 * steering), as in the browser version.
 *
 * With the whole-CNS connectome (the phone app; [smart]), the sensory neurons also fire at
 * their spontaneous background rates and the body follows the website's mapping
 * (web/src/world.js): walking speed, pauses and turns from the leg motor-neuron pools, backing
 * from MDN, voluntary flights from the flight motor neurons, long-mode escapes from the
 * looming DNs, and grooming from the head and leg grooming DNs. The watch circuit has no
 * background, so there the fly wanders on a body-level random walk between your inputs.
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
    val motor = mutableMapOf("forward" to 0.0, "backward" to 0.0, "turn" to 0.0, "escape" to 0.0, "feed" to 0.0, "groom" to 0.0)
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
    private var touchHz = 0.0              // head bristle stimulation
    private var touchUntil = 0.0
    private var groomLeft = 0.0
    private var groomT = 0.0               // seconds into the current bout
    private var groomRest = 1e9            // seconds since the last bout ended
    var rectum = 0.0; private set          // seconds of drinking ready to leave as droplets
    private var sinceDeposit = 0.0
    private var poopLeft = 0.0
    private var poopDone = false

    /** Whole-CNS mode: spontaneous background and brain-driven walking (see the class comment). */
    val smart = c.groups.keys.any { it.startsWith("bg.") }
    private val background = c.groups.filterKeys { it.startsWith("bg.") }.map { (k, v) -> k.removePrefix("bg.").toDouble() to v }
    private val pools = c.groups.keys.filter { it.startsWith("motor.") && it.endsWith(".L") }.map { it.removePrefix("motor.").removeSuffix(".L") }
    /** Every motor pool by side (Hz): smoothed over 60 ms (fast) and 200 ms (slow). */
    val fast = HashMap<String, DoubleArray>()
    private val slow = HashMap<String, DoubleArray>()
    private var heading = 0.0              // smart mode: walking direction, deg (0 = right, 180 = left)
    private var gfOn = 0.0
    private var longOn = 0.0
    private var flightOn = 0.0

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

    /** Long-press on the fly: tickle its head bristles. The circuit decides whether it grooms. */
    fun tickle() {
        if (anim == Anim.FLY) return
        touchHead(TICKLE_HZ, 0.6)
    }

    private fun touchHead(hz: Double, seconds: Double) {
        touchHz = max(if (timeS < touchUntil) touchHz else 0.0, hz)
        touchUntil = max(touchUntil, timeS + seconds)
    }

    /** The player names (or renames) the fly. */
    fun name(name: String) {
        pet.name = name
        pet.named = true
        say("Hello, $name!", 2.5)
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
        // Now and then dust settles on an awake fly's head.
        if (!asleep && anim != Anim.FLY && rng.nextDouble() < dt / DUST_EVERY_S) touchHead(DUST_HZ, 0.8)
        val headHz = if (timeS < touchUntil) touchHz else 0.0
        val key = "$tasteHz ${tasteIdx.size} $loomL $loomR $headHz"
        if (key != lastInputs) {
            lastInputs = key
            brain.clearRates()
            for ((hz, idx) in background) brain.setRates(idx, hz) // stimuli below override these
            if (tasteHz > 0) brain.setRates(tasteIdx, tasteHz)
            if (loomL > 0) brain.setRates(c.group("loom.L"), loomL)
            if (loomR > 0) brain.setRates(c.group("loom.R"), loomR)
            if (headHz > 0) { brain.setRates(c.group("touch.L"), headHz); brain.setRates(c.group("touch.R"), headHz) }
        }

        // ---------- brain ----------
        counts.fill(0)
        brain.run(STEP_MS.toDouble(), counts)
        val a = min(1.0, STEP_MS / SMOOTH_MS)
        val a200 = min(1.0, STEP_MS / 200.0)
        for (g in pools) {
            val r = listOf("L", "R").map { s -> c.group("motor.$g.$s").let { idx -> if (idx.isEmpty()) 0.0 else idx.sumOf { counts[it] } / idx.size.toDouble() / dt } }
            val f = fast.getOrPut(g) { DoubleArray(2) }
            val sl = slow.getOrPut(g) { DoubleArray(2) }
            for (k in 0..1) { f[k] += a * (r[k] - f[k]); sl[k] += a200 * (r[k] - sl[k]) }
            if (g == "turn") { turnLR[0] = f[0]; turnLR[1] = f[1] }
            if (g in motor) motor[g] = max(f[0], f[1])
        }

        // ---------- body ----------
        animTime += dt
        // Gut: food moves toward the rectum; an empty gut still passes a droplet now and then.
        val move = min(pet.gut, pet.gut * dt / GUT_TRANSIT_S)
        pet.gut -= move
        rectum += move + DEPOSIT_UNIT * dt / BASAL_DEPOSIT_S
        sinceDeposit += dt
        // Droppings left lying around sour its mood.
        pet.mood = max(0.0, pet.mood - 0.0005 * pet.droppings.size * dt)
        if (anim == Anim.FLY) return fly(dt)
        if (smart) {
            // Website thresholds (web/src/world.js BODY): the Giant Fiber above 250 Hz, or above
            // 80 Hz for 160 ms; the parallel looming DNs above 40 Hz for 80 ms.
            val gf = motor["escape"]!!
            gfOn = if (gf > 80) gfOn + dt else 0.0
            val jump = mean("takeoffFwd") + mean("takeoffBack")
            longOn = if (jump > 40) longOn + dt else 0.0
            if (gf > 250 || gfOn >= 0.16 || longOn >= 0.08) { gfOn = 0.0; longOn = 0.0; return takeoff() }
        } else if (motor["escape"]!! > ESCAPE_HZ) return takeoff()
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
            pet.gut += dt
            if (boutLeft <= 0 || onFood.amount <= 0) {
                tasteSince = -1.0 // next contact recruits a fresh set of taste neurons
                touchHead(SUGAR_FACE_HZ, 1.0) // sugar left on the face and proboscis
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

        // Defecation: a pause, the abdomen tip dips and a droplet is left behind the fly.
        if (poopLeft > 0 || rectum >= DEPOSIT_UNIT && sinceDeposit >= DEPOSIT_GAP_S && groomLeft <= 0) {
            if (poopLeft <= 0) { poopLeft = DEPOSIT_S; poopDone = false }
            poopLeft -= dt
            if (!poopDone && 1 - poopLeft / DEPOSIT_S >= 0.65) {
                poopDone = true
                rectum = max(0.0, rectum - DEPOSIT_UNIT)
                sinceDeposit = 0.0
                if (pet.droppings.size >= MAX_DROPPINGS) pet.droppings.removeAt(0)
                pet.droppings += (x - facing * 1.3).coerceIn(-HALF_WIDTH + 1, HALF_WIDTH - 1)
                say("Plop!", 1.2)
            }
            speed = 0.0
            return setAnim(Anim.POOP)
        }

        // Voluntary flight: the indirect flight-muscle motor neurons above 15 Hz for 160 ms.
        if (smart) {
            flightOn = if (slowMean("flight") > 15) flightOn + dt else 0.0
            if (flightOn >= 0.16 && !pet.weak) { flightOn = 0.0; return takeoffVoluntary() }
        }

        // Grooming: while DNg12 fires, stop and clean the head (sweeps alternating with leg rubs);
        // with the whole CNS, DNg11-type leg-rubbing DNs start it too.
        // (As on the website: both read over 200 ms, the head DNs by their stronger side, the
        // leg-rubbing DNs averaged over both.)
        val groomDrive = if (smart) max(slowMax("groom"), slowMean("groomLegs")) else motor["groom"]!!
        if (groomDrive > GROOM_HZ) {
            // With the whole CNS, DNg12 also bursts at rest (as high as a tickle drives it):
            // without a cue on the head, bouts are capped and spaced (web/src/world.js BODY).
            val cued = !smart || timeS < touchUntil + 1.0 // the DNs lag the touch
            val ok = if (groomLeft > 0) cued || groomT < GROOM_SPONT_S else cued || groomRest >= GROOM_REST_S
            if (ok) groomLeft = max(groomLeft, GROOM_BOUT_S)
        }
        if (groomLeft > 0) { groomT += dt; groomRest = 0.0 } else { groomT = 0.0; groomRest += dt }
        if (groomLeft > 0) {
            groomLeft -= dt
            speed = 0.0
            if (anim != Anim.GROOM && rng.nextDouble() < 0.3) say("Cleaning up", 1.2)
            return setAnim(Anim.GROOM)
        }

        // Wander or approach food (body-level), modulated by P9 (forward) and MDN (backward).
        // Only a completely full fly ignores food; otherwise the circuit decides at the drop.
        val target = food.filter { it.amount > 0 && timeS >= it.ignoredUntil && pet.satiety < 99 }.minByOrNull { abs(it.x - x) }
        if (smart) return walkSmart(dt, target)
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

    private fun mean(g: String) = fast[g]?.let { (it[0] + it[1]) / 2 } ?: 0.0
    private fun slowMean(g: String) = slow[g]?.let { (it[0] + it[1]) / 2 } ?: 0.0
    private fun slowMax(g: String) = slow[g]?.let { max(it[0], it[1]) } ?: 0.0

    /**
     * Whole-CNS walking (web/src/world.js): speed from the leg motor-neuron pools, plus P9,
     * minus MDN above 30 Hz; turning from DNa01/02 and the left-right leg difference. The fly
     * walks in 2D: the stage shows its motion along x, so turning toward or away from you
     * slows it on screen and turning past side-on flips it.
     */
    private fun walkSmart(dt: Double, target: Food?) {
        val legsL = slow["legs"]?.get(0) ?: 0.0
        val legsR = slow["legs"]?.get(1) ?: 0.0
        val back = max(0.0, mean("backward") - 30.0)
        var cmd = 6.0 * max(0.0, (legsL + legsR) / 2 - 1.5) + FWD_GAIN * mean("forward") - 0.4 * back
        var turn = 25.0 * (turnLR[0] - turnLR[1]) + 150.0 * (legsL - legsR) + 40.0 * gauss()
        if (target != null) {
            // Food in reach: it heads for it (smell and sight, body-level) at least at a slow walk.
            val want = if (target.x > x) 0.0 else 180.0
            val err = ((want - heading + 540) % 360) - 180
            turn = err * 4
            if (abs(target.x - x) > 0.4) cmd = max(cmd, BASE_SPEED * (if (pet.weak) 0.3 else 0.5 + pet.energy / 200)) else cmd = 0.0
        }
        cmd = cmd.coerceIn(-10.0, MAX_SPEED)
        speed += (cmd - speed) * min(1.0, dt / 0.1)
        heading = (heading + (if (abs(speed) > 0.3) turn else turn * 0.3) * dt + 360) % 360
        var vx = speed * kotlin.math.cos(Math.toRadians(heading))
        val nx = x + vx * dt
        if (abs(nx) > HALF_WIDTH - 2) { heading = (540 - heading) % 360; vx = -vx } // turn back at the edge
        x = (x + vx * dt).coerceIn(-HALF_WIDTH + 2, HALF_WIDTH - 2)
        val c = kotlin.math.cos(Math.toRadians(heading))
        if (abs(c) > 0.1) facing = if (c > 0) 1 else -1 // the head's side; backing moves the other way
        walkPhase += abs(speed) * dt / STRIDE_MM
        setAnim(if (abs(speed) > 0.3) Anim.WALK else Anim.IDLE)
    }

    private fun gauss(): Double {
        val u = 1 - rng.nextDouble()
        return kotlin.math.sqrt(-2 * kotlin.math.ln(u)) * kotlin.math.cos(2 * Math.PI * rng.nextDouble())
    }

    /** A flight the fly chose (flight motor neurons): no stress, a longer trip across the stage. */
    private fun takeoffVoluntary() {
        boutLeft = 0.0
        tasteSince = -1.0
        flightLeft = 1.2 + rng.nextDouble() * 1.5
        flightTarget = (rng.nextDouble() - 0.5) * 2 * (HALF_WIDTH - 6)
        facing = if (flightTarget > x) 1 else -1
        heading = if (facing > 0) 0.0 else 180.0
        say("Off for a flight", 1.5)
        setAnim(Anim.FLY)
    }

    /** Clean up the droppings; a clean home cheers the pet up. Returns how many there were. */
    fun clean(): Int {
        val n = pet.droppings.size
        if (n == 0) return 0
        pet.droppings.clear()
        pet.cleans++
        pet.mood = min(100.0, pet.mood + min(15.0, 2.0 * n))
        say(if (n == 1) "Cleaned up 1 dropping" else "Cleaned up $n droppings")
        return n
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
        heading = if (facing > 0) 0.0 else 180.0
        say(if (escapeTimes.size > 2) "Leave me alone!" else "Whoosh!", 1.5)
        setAnim(Anim.FLY)
    }

    private fun fly(dt: Double) {
        poopLeft = 0.0
        flightLeft -= dt
        val total = max(0.2, flightLeft + animTime)
        val f = (animTime / total).coerceIn(0.0, 1.0)
        x += (flightTarget - x) * min(1.0, dt * 3)
        z = 12 * Math.sin(Math.PI * f)
        if (flightLeft <= 0) { z = 0.0; setAnim(Anim.IDLE) }
    }

    private fun setAnim(a: Anim) {
        if (a != anim) { anim = a; animTime = 0.0 }
    }

    companion object {
        const val STEP_MS = 20
        const val TICKLE_HZ = 120.0       // head bristles during a tickle
        const val SUGAR_FACE_HZ = 70.0    // after a meal
        const val DUST_HZ = 60.0
        const val DUST_EVERY_S = 75.0     // mean interval between dust specks
        const val GROOM_HZ = 3.0          // DNg12 (smoothed) above this -> grooming
        const val GROOM_BOUT_S = 1.5
        const val GROOM_SPONT_S = 3.0     // longest uncued bout (whole CNS)
        const val GROOM_REST_S = 8.0      // and the least time between them
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
        const val MAX_SPEED = 20.0        // mm/s, whole-CNS walking (the stage is 60 mm wide)
        const val FWD_GAIN = 0.25
        const val BACK_GAIN = 0.3
        const val TURN_HZ = 25.0
        const val STRIDE_MM = 1.6
        // Defecation (web/src/world.js BODY; compressed: a real fly's gut takes about an hour).
        const val GUT_TRANSIT_S = 60.0     // a meal reaches the rectum
        const val DEPOSIT_UNIT = 1.5       // seconds of drinking per droplet
        const val DEPOSIT_GAP_S = 12.0     // least time between droplets
        const val DEPOSIT_S = 1.1          // the pause and abdomen dip; the droplet leaves at 65%
        const val BASAL_DEPOSIT_S = 240.0  // an empty gut still passes one about this often
        const val MAX_DROPPINGS = 20
    }
}
