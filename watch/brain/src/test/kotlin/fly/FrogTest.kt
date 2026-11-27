package fly

import fly.game.Frog
import fly.game.FrogKind
import fly.game.FrogMode
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class FrogTest {
    private fun run(f: Frog, seconds: Double, flyX: Double, away: (Double) -> Boolean = { false }): List<Frog.Event> {
        val events = mutableListOf<Frog.Event>()
        var t = 0.0
        while (t < seconds) {
            f.step(0.02, flyX, 0.0, flyMoving = true, flyAway = away(t))?.let { events += it }
            t += 0.02
        }
        return events
    }

    @Test
    fun frogHuntsAMovingFlyAndCatchesIt() {
        val f = Frog(FrogKind.SMALL, -30.0, 45.0, Random(1))
        val events = run(f, 90.0, flyX = 5.0)
        println("frog events: $events")
        assertTrue(Frog.Event.APPROACH in events, "it comes in on the fly")
        assertTrue(Frog.Event.STRIKE in events)
        assertTrue(Frog.Event.CAUGHT in events)
        assertTrue(f.depth >= Frog.MIN_DEPTH && f.depth <= Frog.MAX_DEPTH)
    }

    @Test
    fun aFlyThatTakesOffIsNotCaught() {
        val f = Frog(FrogKind.BIG, 30.0, 50.0, Random(2))
        // the fly is always away (flying) by the time the tongue would reach it
        val events = run(f, 90.0, flyX = 0.0) { true }
        assertTrue(Frog.Event.CAUGHT !in events)
        assertTrue(Frog.Event.STRIKE !in events, "a frog doesn't strike at a fly in the air")
    }

    @Test
    fun spriteFramesStayInRange() {
        val f = Frog(FrogKind.SMALL, 0.0, 20.0, Random(3))
        repeat(5000) {
            f.step(0.02, 3.0, 0.0, flyMoving = true, flyAway = false)
            val n = if (f.mode == FrogMode.SIT) 1 else 10
            assertTrue(f.frame in 0 until n, "frame ${f.frame} of ${f.mode}")
            assertTrue(f.tongueOut in 0.0..1.0)
        }
        assertEquals(true, true)
    }
}
