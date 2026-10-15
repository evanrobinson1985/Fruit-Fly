package fly

import fly.brain.Brain
import fly.brain.Connectome
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val assets = File("../app/src/main/assets")

internal fun loadCircuit() = Connectome.read(File(assets, "brain.bin").inputStream(), File(assets, "brain.txt").inputStream())

/** Mean rate (Hz) of the most active side of a motor group. */
private fun rate(c: Connectome, counts: IntArray, group: String, ms: Double) =
    listOf("L", "R").maxOf { s -> c.group("motor.$group.$s").let { idx -> idx.sumOf { counts[it] } / idx.size.toDouble() } } / (ms / 1000)

class BrainTest {
    private val c = loadCircuit()

    @Test
    fun loadsCircuit() {
        assertEquals(15154, c.n)
        assertEquals(72, c.group("taste").size)
    }

    @Test
    fun silentWithoutInput() {
        val b = Brain(c)
        val counts = IntArray(c.n)
        b.run(300.0, counts)
        assertEquals(0, counts.sum())
    }

    /** Python (watch/VALIDATION.md): Giant Fiber ~285 Hz, MN9 0 Hz. */
    @Test
    fun loomingDrivesGiantFiber() {
        val b = Brain(c, seed = 3)
        b.setRates(c.group("loom.L") + c.group("loom.R"), 100.0)
        val counts = IntArray(c.n)
        val t0 = System.nanoTime()
        b.run(500.0, counts)
        val wall = (System.nanoTime() - t0) / 1e6
        val gf = rate(c, counts, "escape", 500.0)
        println("loom: GF $gf Hz, MN9 ${rate(c, counts, "feed", 500.0)} Hz, wall $wall ms for 500 ms")
        assertTrue(gf in 200.0..350.0)
        assertEquals(0.0, rate(c, counts, "feed", 500.0))
    }

    /** Python: MN9 ~20 Hz mean over 500 ms of all taste neurons at 80 Hz; no Giant Fiber. */
    @Test
    fun tasteDrivesMn9() {
        val means = (1..3).map { seed ->
            val b = Brain(c, seed = seed)
            b.setRates(c.group("taste"), 80.0)
            val counts = IntArray(c.n)
            b.run(500.0, counts)
            assertEquals(0.0, rate(c, counts, "escape", 500.0))
            rate(c, counts, "feed", 500.0)
        }
        println("taste: MN9 $means Hz")
        assertTrue(means.average() in 8.0..40.0)
    }
}
