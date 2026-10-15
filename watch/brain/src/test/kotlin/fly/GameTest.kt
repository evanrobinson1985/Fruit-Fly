package fly

import fly.game.Anim
import fly.game.FlyWorld
import fly.game.Pet
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GameTest {
    private val c = loadCircuit()

    private fun runUntil(w: FlyWorld, seconds: Double, stop: (FlyWorld) -> Boolean = { false }): Boolean {
        repeat((seconds * 1000 / FlyWorld.STEP_MS).toInt()) {
            w.step()
            if (stop(w)) return true
        }
        return false
    }

    @Test
    fun hungryFlyWalksToFoodAndEats() {
        val pet = Pet(satiety = 5.0)
        val w = FlyWorld(c, pet, seed = 4)
        w.dropFood(12.0)
        val ate = runUntil(w, 15.0) { it.anim == Anim.FEED }
        assertTrue(ate, "a starving fly should feed")
        runUntil(w, 3.0)
        println("hungry: satiety=${pet.satiety} bouts=${pet.feedings}")
        assertTrue(pet.satiety > 10.0)
        assertTrue(pet.feedings >= 1)
    }

    @Test
    fun satiatedFlyMostlyRefuses() {
        // Over several trials a full fly should feed far less often than a starving one.
        fun feedRate(satiety: Double) = (1..6).count { seed ->
            val w = FlyWorld(c, Pet(satiety = satiety), seed = seed)
            w.dropFood(6.0)
            runUntil(w, 12.0) { it.anim == Anim.FEED }
        }
        val full = feedRate(99.0)
        val starving = feedRate(0.0)
        println("feeding in 6 trials: full=$full starving=$starving")
        assertTrue(starving >= 5)
        assertTrue(full <= 3)
    }

    @Test
    fun tapTriggersEscapeFlight() {
        val pet = Pet()
        val w = FlyWorld(c, pet, seed = 2)
        runUntil(w, 0.5)
        w.tap(w.x - 10)
        val flew = runUntil(w, 1.5) { it.anim == Anim.FLY }
        println("tap: flew=$flew GF=${w.motor["escape"]} escapes=${pet.escapes}")
        assertTrue(flew)
        assertEquals(1, pet.escapes)
    }

    @Test
    fun timePassesWhileAway() {
        val pet = Pet.newborn(0L)
        pet.advance((6 * Pet.HOUR_MS).toLong(), asleepFraction = 0.0)
        assertEquals(70.0 - 6 * Pet.SATIETY_PER_HOUR, pet.satiety, 1e-9)
        assertTrue(pet.energy < 80.0)
        assertEquals(1, pet.ageDays((6 * Pet.HOUR_MS).toLong()))
    }
}
