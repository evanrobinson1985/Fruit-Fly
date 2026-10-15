package fly.game

import kotlin.math.max
import kotlin.math.min

/**
 * The pet's long-term state. Values are 0..100. Time passes while the app is
 * closed: [advance] is applied with the elapsed wall-clock time on every resume.
 */
data class Pet(
    var satiety: Double = 70.0,   // 100 = full crop, 0 = starving
    var energy: Double = 80.0,    // drops while awake, restored by sleep
    var mood: Double = 60.0,
    var bornAtMs: Long = 0L,
    var updatedAtMs: Long = 0L,
    var feedings: Int = 0,
    var escapes: Int = 0,
    var name: String = "Dot",
) {
    /** 0 (full) .. 1 (starving). */
    val hunger get() = 1.0 - satiety / 100.0

    val weak get() = satiety <= 0.5

    fun ageDays(nowMs: Long) = ((nowMs - bornAtMs) / DAY_MS).toInt() + 1

    /**
     * Number of sugar-sensing taste neurons that respond when the fly touches food.
     * Starvation raises sugar-neuron sensitivity (Inagaki et al. 2012), recruiting more of
     * them; in the watch circuit ~12+ responding neurons reliably drive MN9, 1-4 rarely do
     * (watch/VALIDATION.md).
     */
    fun tasteRecruitment(): Int = (1 + 39 * Math.pow(hunger, 1.4)).toInt().coerceIn(1, 40)

    /** Apply elapsed time. [asleepFraction] is the share of it spent asleep (night). */
    fun advance(nowMs: Long, asleepFraction: Double) {
        val h = max(0L, nowMs - updatedAtMs) / HOUR_MS
        updatedAtMs = nowMs
        if (h <= 0) return
        satiety = clamp(satiety - h * SATIETY_PER_HOUR * (1 - 0.5 * asleepFraction)) // metabolism slows in sleep
        energy = clamp(energy - h * (1 - asleepFraction) * ENERGY_AWAKE_PER_HOUR + h * asleepFraction * ENERGY_SLEEP_PER_HOUR)
        val target = 60.0 - (if (satiety < 25) 30.0 else 0.0) - (if (energy < 20) 15.0 else 0.0)
        mood += (target - mood) * min(1.0, h / 6.0)
        mood = clamp(mood)
    }

    fun ate(amount: Double) {
        satiety = clamp(satiety + amount)
        mood = clamp(mood + amount * 0.4)
    }

    fun boutStarted() {
        feedings++
    }

    /** An escape flight: exercise if occasional, stress if the fly keeps getting chased. */
    fun escaped(recentEscapes: Int) {
        escapes++
        energy = clamp(energy - 2.0)
        mood = clamp(mood + if (recentEscapes <= 2) 2.0 else -6.0)
    }

    companion object {
        const val HOUR_MS = 3_600_000.0
        const val DAY_MS = 86_400_000L
        const val SATIETY_PER_HOUR = 8.0        // full to empty in ~12 h awake
        const val ENERGY_AWAKE_PER_HOUR = 5.0
        const val ENERGY_SLEEP_PER_HOUR = 12.0
        fun clamp(v: Double) = v.coerceIn(0.0, 100.0)

        fun newborn(nowMs: Long) = Pet(bornAtMs = nowMs, updatedAtMs = nowMs)
    }
}
