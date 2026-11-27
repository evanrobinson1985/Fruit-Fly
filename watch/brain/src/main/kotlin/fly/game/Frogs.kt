package fly.game

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sign
import kotlin.math.sqrt
import kotlin.random.Random

// The website's two frogs (web/src/predators.js) on the watch's stage. The stage is a line
// along the pond's south bank; a frog is somewhere along it (x, mm) and some way behind it
// (depth, mm: they sit at the pond's edge, 60-100 mm back). Mostly they sit there and now and
// then hop to a new spot. When the fly moves within sight, a frog hunts: it hops in toward
// the path, coming in front of the fly from the side, and strikes with its tongue once the
// fly is in reach. An approaching frog looms on the fly's eye on that side, so the fly's
// Giant Fiber can fire and it takes off in time (FlyWorld). Sizes and timings are the
// sprites' (watch/tools/frogs.html, frogs.json), which match the website's.

enum class FrogMode { SIT, HOP, STRIKE }

data class FrogKind(
    val id: String, val name: String, val length: Double,
    val mouth: Double,       // mm ahead of its origin
    val reach: Double,       // tongue reach from the mouth (mm)
    val hopLength: Double,   // a full hop (mm)
    val hopStart: Double, val hopEnd: Double, val hopDur: Double, // gather, take-off .. landing, settled (s)
    val sight: Double,       // mm at which it notices a moving fly
) {
    companion object {
        val SMALL = FrogKind("small", "Montane Brown Frog", 42.0, 19.3, 31.5, 42.0 * 1.4, 0.12, 0.388, 0.648, 170.0)
        val BIG = FrogKind("big", "Japanese Toad", 70.0, 32.3, 52.5, 70.0 * 0.55, 0.2, 0.507, 0.907, 200.0)
    }
}

class Frog(val kind: FrogKind, var x: Double, var depth: Double, private val rng: Random) {
    var facing = 1; private set
    var mode = FrogMode.SIT; private set
    var t = 0.0; private set
    private var sitLeft = 2.0 + 4 * rng.nextDouble()
    private var hx0 = 0.0; private var hd0 = 0.0; private var hx1 = 0.0; private var hd1 = 0.0
    var cooldown = 15.0 + 20 * rng.nextDouble(); private set // before it will hunt
    var hunting = 0.0; private set
    var holding = false; private set  // the fly is on its tongue
    private var resolved = false

    /** 0..1: how far the tongue is out (a strike), and whether it hit. */
    val tongueOut: Double get() {
        if (mode != FrogMode.STRIKE) return 0.0
        val back = if (holding) doubleArrayOf(0.15, 0.32) else doubleArrayOf(0.13, 0.15)
        return if (t < 0.11) ease((t - 0.03) / 0.08) else 1 - ease((t - back[0]) / back[1])
    }

    /** Sprite frame: sit 0; hop 0..9 (crouch, eight in the air, landing); strike 0..9. */
    val frame: Int get() = when (mode) {
        FrogMode.SIT -> 0
        FrogMode.HOP -> when {
            t < kind.hopStart -> 0
            t < kind.hopEnd -> 1 + ((t - kind.hopStart) / (kind.hopEnd - kind.hopStart) * 8).toInt().coerceIn(0, 7)
            else -> 9
        }
        FrogMode.STRIKE -> STRIKE_T.indexOfLast { it <= t + 0.005 }.coerceAtLeast(0)
    }

    /** Where its mouth is along the stage. */
    val mouthX get() = x + facing * kind.mouth

    /** From its mouth to the fly at stage x (mm). */
    fun gap(flyX: Double) = hypot(flyX - mouthX, depth)

    private fun hop(toX: Double, toDepth: Double) {
        var dx = toX - x
        var dd = toDepth - depth
        val d = hypot(dx, dd)
        if (d > kind.hopLength) { dx *= kind.hopLength / d; dd *= kind.hopLength / d }
        hx0 = x; hd0 = depth; hx1 = (x + dx).coerceIn(-FlyWorld.HALF_WIDTH - 20, FlyWorld.HALF_WIDTH + 20)
        hd1 = (depth + dd).coerceIn(MIN_DEPTH, MAX_DEPTH)
        if (abs(dx) > 0.5) facing = sign(dx).toInt()
        mode = FrogMode.HOP
        t = 0.0
    }

    private fun sit(seconds: Double) { mode = FrogMode.SIT; t = 0.0; sitLeft = seconds }

    /**
     * One step. Returns what happened: [Event.APPROACH] as it starts a hop in on the fly (it
     * looms on the fly's eye), [Event.STRIKE] as the tongue goes out, [Event.CAUGHT] when it
     * catches the fly.
     */
    fun step(dt: Double, flyX: Double, flyZ: Double, flyMoving: Boolean, flyAway: Boolean): Event? {
        t += dt
        cooldown = max(0.0, cooldown - dt)
        hunting = max(0.0, hunting - dt)
        val distance = hypot(flyX - x, depth)
        val canHunt = !flyAway && cooldown <= 0 && flyZ < 3
        if (canHunt && flyMoving && distance < kind.sight) hunting = 8.0
        when (mode) {
            FrogMode.HOP -> {
                val p = ((t - kind.hopStart) / (kind.hopEnd - kind.hopStart)).coerceIn(0.0, 1.0)
                x = hx0 + (hx1 - hx0) * p
                depth = hd0 + (hd1 - hd0) * p
                if (t >= kind.hopDur) {
                    if (hunting > 0 && canHunt && gap(flyX) < kind.reach) return strike(flyX)
                    sit(if (hunting > 0) 0.3 + 0.6 * rng.nextDouble() else 2.5 + 6 * rng.nextDouble())
                }
            }
            FrogMode.STRIKE -> {
                // the tongue is fully out at 0.11 s: if the fly is still there it sticks
                if (!resolved && t >= 0.11) {
                    resolved = true
                    if (!flyAway && flyZ < 3 && gap(flyX) < kind.reach * 1.05) { holding = true; return Event.CAUGHT }
                }
                if (t >= (if (holding) 0.6 else 0.42)) {
                    if (holding) { holding = false; hunting = 0.0; cooldown = 45 + 30 * rng.nextDouble(); sit(10 + 10 * rng.nextDouble()) }
                    else { cooldown = 4 + 4 * rng.nextDouble(); sit(0.8 + rng.nextDouble()) }
                }
            }
            FrogMode.SIT -> {
                sitLeft -= dt
                if (hunting > 0 && canHunt) {
                    if (abs(flyX - x) > 0.5) facing = sign(flyX - x).toInt()
                    if (gap(flyX) < kind.reach && (flyMoving || sitLeft <= 0)) return strike(flyX)
                    if (sitLeft <= 0) {
                        // in toward the path, its mouth off to the fly's side and inside reach
                        // (from well back: a frog close up would fill the watch's screen)
                        val d = (kind.reach * 0.65).coerceIn(MIN_DEPTH, MAX_DEPTH)
                        val side = if (x <= flyX) -1 else 1
                        val along = sqrt(max(0.0, (kind.reach * 0.85) * (kind.reach * 0.85) - d * d))
                        hop(flyX + side * (kind.mouth + along), d)
                        // a hop that ends in reach is an attack: the fly sees it coming
                        return if (hypot(hx1 + (if (hx1 < flyX) 1 else -1) * kind.mouth - flyX, hd1) < kind.reach * 1.3) Event.APPROACH else null
                    }
                } else if (sitLeft <= 0) {
                    // back to the pond's edge (60-100 mm behind the path) after a hunt, otherwise
                    // a hop or two along the bank there
                    val home = if (depth < HOME_DEPTH || rng.nextDouble() < 0.3) HOME_DEPTH + 40 * rng.nextDouble() else depth + (rng.nextDouble() - 0.5) * 12
                    hop(x + (rng.nextDouble() - 0.5) * 2 * kind.hopLength, home)
                }
            }
        }
        return null
    }

    private fun strike(flyX: Double): Event {
        if (abs(flyX - x) > 0.5) facing = sign(flyX - x).toInt()
        mode = FrogMode.STRIKE
        t = 0.0
        resolved = false
        holding = false
        return Event.STRIKE
    }

    enum class Event { APPROACH, STRIKE, CAUGHT }

    companion object {
        const val MIN_DEPTH = 6.0     // never on the path itself
        const val HOME_DEPTH = 60.0   // the pond's edge, where they sit between hunts
        const val MAX_DEPTH = 105.0
        val STRIKE_T = doubleArrayOf(0.02, 0.05, 0.07, 0.09, 0.11, 0.14, 0.18, 0.22, 0.28, 0.36)
        fun ease(u: Double): Double { val c = u.coerceIn(0.0, 1.0); return c * c * (3 - 2 * c) }
    }
}
