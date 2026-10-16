package fly

import fly.brain.WebConnectome
import fly.game.Anim
import fly.game.FlyWorld
import fly.game.Pet
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The phone game's whole-CNS mode: the website's connectome (web/assets) in the Kotlin engine,
 * with spontaneous background and brain-driven walking (FlyWorld.smart).
 */
class FullBrainTest {
    private val c by lazy {
        val dir = File("../../web/assets")
        val t = System.nanoTime()
        WebConnectome.read { File(dir, it).inputStream() }.also {
            println("loaded ${it.n} neurons, ${it.post.size} connections in ${(System.nanoTime() - t) / 1_000_000} ms")
        }
    }

    private fun run(w: FlyWorld, seconds: Double, stop: (FlyWorld) -> Boolean = { false }): Boolean {
        repeat((seconds * 1000 / FlyWorld.STEP_MS).toInt()) {
            w.step()
            if (stop(w)) return true
        }
        return false
    }

    @Test
    fun loadsTheWholeConnectome() {
        assertEquals(165_122, c.n)
        assertEquals(23_446_109, c.post.size)
        assertTrue(c.group("motor.legs.L").isNotEmpty() && c.group("taste").isNotEmpty())
        assertTrue(FlyWorld(c, Pet()).smart)
    }

    @Test
    fun aRestingFlyBehavesOnItsOwn() {
        val w = FlyWorld(c, Pet(satiety = 80.0, energy = 80.0), seed = 3)
        val time = HashMap<Anim, Int>()
        var travelled = 0.0
        var reversals = 0
        var flights = 0
        var lastX = w.x
        var lastFacing = w.facing
        var lastAnim = w.anim
        val t0 = System.nanoTime()
        val seconds = 40.0
        repeat((seconds * 1000 / FlyWorld.STEP_MS).toInt()) {
            w.step()
            time.merge(w.anim, 1, Int::plus)
            travelled += kotlin.math.abs(w.x - lastX); lastX = w.x
            if (w.facing != lastFacing) reversals++; lastFacing = w.facing
            if (w.anim == Anim.FLY && lastAnim != Anim.FLY) flights++
            lastAnim = w.anim
        }
        val wall = (System.nanoTime() - t0) / 1e9
        val share = time.mapValues { (_, n) -> "%.0f%%".format(100.0 * n * FlyWorld.STEP_MS / 1000 / seconds) }
        println("whole CNS at rest, $seconds s: $share, travelled ${"%.0f".format(travelled)} mm, $reversals turns, " +
            "$flights flights, legs ${w.fast["legs"]?.toList()}, ${"%.2f".format(seconds / wall)}x real time on this machine")
        assertTrue(travelled > 5.0, "the fly should walk on its own")
        assertTrue((time[Anim.FLY] ?: 0) < time.values.sum() / 2, "it should not spend most of its time flying")
        assertTrue((time[Anim.GROOM] ?: 0) < time.values.sum() / 2, "it should not spend most of its time grooming")
        assertTrue((time[Anim.WALK] ?: 0) > time.values.sum() / 5, "it should spend a good share of its time walking")
    }

    @Test
    fun aLoomingHandMakesItEscape() {
        val pet = Pet()
        val w = FlyWorld(c, pet, seed = 2)
        run(w, 1.0)
        w.tap(w.x - 10)
        val flew = run(w, 1.5) { it.anim == Anim.FLY }
        println("whole CNS tap: flew=$flew GF=${w.motor["escape"]}")
        assertTrue(flew)
    }

    @Test
    fun aHungryFlyFindsFoodAndEats() {
        val pet = Pet(satiety = 5.0)
        val w = FlyWorld(c, pet, seed = 4)
        w.dropFood(w.x + 10.0)
        val ate = run(w, 25.0) { it.anim == Anim.FEED }
        println("whole CNS hungry: ate=$ate satiety=${pet.satiety} MN9=${w.motor["feed"]}")
        assertTrue(ate)
    }
}
