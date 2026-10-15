package fly

import fly.game.Anim
import fly.game.FlyWorld
import fly.game.Pet
import java.awt.AlphaComposite
import java.awt.BasicStroke
import java.awt.Color
import java.awt.Font
import java.awt.GradientPaint
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.geom.Arc2D
import java.awt.geom.Ellipse2D
import java.awt.geom.RoundRectangle2D
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.random.Random
import kotlin.test.Test

/**
 * Renders previews of the watch screen on the JVM, driving the real game logic and
 * connectome circuit and redrawing the scene with the same geometry, colors and
 * sprites as app/.../MainActivity.kt (drawScene, drawStats, the Feed button and
 * message bubble). Not a capture from a device.
 *
 *   ./gradlew -PbrainOnly :brain:test --tests fly.PreviewRender -PpreviewDir=<out> -PspriteDir=<png frames>
 */
class PreviewRender {
    private val out = System.getProperty("previewDir")?.let(::File)
    private val spriteDir = System.getProperty("spriteDir")?.let(::File)

    private val px = 480                 // Galaxy Watch Ultra: 480 x 480
    private val dp = 2f                   // xhdpi-class watch density
    private val sprites by lazy {
        spriteDir!!.listFiles()!!.filter { it.name.endsWith(".png") }.sortedBy { it.name }
            .groupBy { it.name.substringBefore("_") }.mapValues { (_, fs) -> fs.map { ImageIO.read(it) } }
    }

    // Same palette as MainActivity.kt
    private val amber = Color(0xE6, 0xA8, 0x4A)
    private val energyBlue = Color(0x7F, 0xB6, 0xE8)
    private val moodPink = Color(0xE8, 0x8F, 0xA8)
    private val ink = Color(0xF4, 0xED, 0xE2)

    private val stars = List(40) { Pair(Random(it).nextFloat(), Random(it + 99).nextFloat() * 0.6f) }
    private val tufts = List(70) { Triple(Random(it * 7).nextFloat(), Random(it * 13).nextFloat(), Random(it * 3).nextFloat()) }

    private fun argb(v: Long) = Color(((v shr 16) and 0xFF).toInt(), ((v shr 8) and 0xFF).toInt(), (v and 0xFF).toInt(), ((v shr 24) and 0xFF).toInt())

    private fun pick(w: FlyWorld): BufferedImage = when (w.anim) {
        Anim.IDLE -> sprites.getValue("idle").let { it[(w.animTime * 6).toInt() % it.size] }
        Anim.WALK -> sprites.getValue("walk").let { it[((((w.walkPhase % 1) + 1) % 1) * it.size).toInt().coerceIn(0, it.size - 1)] }
        Anim.FEED -> sprites.getValue("feed").let { it[(w.proboscis * 5).roundToInt().coerceIn(0, 5)] }
        Anim.FLY -> sprites.getValue("fly").let { it[(w.animTime * 25).toInt() % it.size] }
        Anim.SLEEP -> sprites.getValue("sleep")[0]
        Anim.GROOM -> sprites.getValue("groom").let {
            val rub = (w.animTime / 1.1).toInt() % 2 == 1
            it[(if (rub) 6 else 0) + ((w.animTime * (if (rub) 5 else 3) * 6).toInt() % 6)]
        }
    }

    fun render(w: FlyWorld, night: Boolean = false, file: File) {
        val img = BufferedImage(px, px, BufferedImage.TYPE_INT_ARGB)
        val g = img.createGraphics()
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
        g.clip = Ellipse2D.Float(0f, 0f, px.toFloat(), px.toFloat()) // round face
        val size = px.toFloat()
        val scale = size * 0.40f / FlyWorld.HALF_WIDTH.toFloat()
        val groundY = size * 0.68f
        val flySize = size * 0.46f

        // drawScene: sky, stars, ground, tufts
        val sky = if (night) listOf(argb(0xFF0B1328), argb(0xFF1E2C4E)) else listOf(argb(0xFF9FD3EA), argb(0xFFF2E6C8))
        g.paint = GradientPaint(0f, 0f, sky[0], 0f, groundY, sky[1]); g.fillRect(0, 0, px, groundY.toInt())
        if (night) { g.color = argb(0xCCFFFFFF); stars.forEach { (x, y) -> g.fill(Ellipse2D.Float(x * size - 1.6f, y * groundY - 1.6f, 3.2f, 3.2f)) } }
        g.paint = GradientPaint(0f, groundY, argb(0xFF4F7A33), 0f, size, argb(0xFF2C431E)); g.fillRect(0, groundY.toInt(), px, px - groundY.toInt())
        g.stroke = BasicStroke(2f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND)
        tufts.forEach { (tx, ty, th) ->
            val bx = tx * size; val by = groundY + ty * (size - groundY) * 0.5f; val len = 6f + th * 14f
            g.color = argb(0xFF6E9E45); g.drawLine(bx.toInt(), by.toInt(), (bx - 3).toInt(), (by - len).toInt())
            g.color = argb(0xFF5C8A3A); g.drawLine((bx + 3).toInt(), by.toInt(), (bx + 6).toInt(), (by - len * 0.8f).toInt())
        }
        val standY = groundY + size * 0.035f
        // sugar drops
        for (f in w.food.filter { it.amount > 0 }) {
            val cx = size / 2 + f.x.toFloat() * scale
            val r = 7f + 9f * (f.amount / 30.0).toFloat()
            g.color = argb(0xFFD9A441); g.fill(Ellipse2D.Float(cx - r, standY - r * 0.55f, 2 * r, r * 0.9f))
            g.color = argb(0x99FFF4D6); g.fill(Ellipse2D.Float(cx - r * 0.45f, standY - r * 0.45f, r * 0.5f, r * 0.25f))
        }
        // fly + shadow
        val sprite = pick(w)
        val fx = size / 2 + w.x.toFloat() * scale
        val top = standY - w.z.toFloat() * scale - flySize * 0.756f
        g.color = argb(0x33000000); g.fill(Ellipse2D.Float(fx - flySize * 0.22f, standY - 3f, flySize * 0.44f, 7f))
        val x0 = (fx - flySize / 2).toInt(); val s = flySize.toInt()
        if (w.facing > 0) g.drawImage(sprite, x0, top.toInt(), s, s, null)
        else g.drawImage(sprite, x0 + s, top.toInt(), -s, s, null)
        if (w.anim == Anim.SLEEP) {
            val t = (w.animTime % 2.0).toFloat()
            g.color = argb(0xCCF4EDE2)
            g.font = Font(Font.SANS_SERIF, Font.PLAIN, 22); g.drawString("z", fx + flySize * 0.2f, top + flySize * 0.25f - t * 12)
            g.font = Font(Font.SANS_SERIF, Font.PLAIN, 28); g.drawString("Z", fx + flySize * 0.28f, top + flySize * 0.12f - t * 12)
        }
        // drawStats: three arcs, start 205 deg clockwise from 3 o'clock, sweep 130
        val p = w.pet
        listOf(p.satiety to amber, p.energy to energyBlue, p.mood to moodPink).forEachIndexed { k, (v, color) ->
            val inset = 8f + k * 11f
            g.stroke = BasicStroke(7f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND)
            g.color = argb(0x33FFFFFF)
            g.draw(Arc2D.Float(inset, inset, size - 2 * inset, size - 2 * inset, -205f, -130f, Arc2D.OPEN))
            g.color = color
            g.draw(Arc2D.Float(inset, inset, size - 2 * inset, size - 2 * inset, -205f, -130f * (v / 100.0).toFloat().coerceIn(0.01f, 1f), Arc2D.OPEN))
        }
        // message bubble (top center, 58dp down)
        w.message?.let { msg ->
            g.font = Font(Font.SANS_SERIF, Font.PLAIN, (13 * dp).toInt())
            val fm = g.fontMetrics
            val tw = fm.stringWidth(msg); val bw = tw + 16 * dp; val bh = fm.height + 6 * dp
            val bx = size / 2 - bw / 2; val by = 58 * dp
            g.color = argb(0x99201A14); g.fill(RoundRectangle2D.Float(bx, by, bw, bh, 20 * dp, 20 * dp))
            g.color = ink; g.drawString(msg, size / 2 - tw / 2, by + 3 * dp + fm.ascent)
        }
        // Feed button (52dp circle, 14dp from bottom) and info chip (30dp, offset 52dp, 30dp from bottom)
        val fb = 52 * dp; val fby = size - 14 * dp - fb
        g.color = amber; g.fill(Ellipse2D.Float(size / 2 - fb / 2, fby, fb, fb))
        g.color = argb(0xFF2A1C0A); g.font = Font(Font.SANS_SERIF, Font.BOLD, (13 * dp).toInt())
        g.fontMetrics.let { fm -> g.drawString("Feed", size / 2 - fm.stringWidth("Feed") / 2, fby + fb / 2 + fm.ascent / 2 - 2) }
        val ib = 30 * dp; val ibx = size / 2 + 52 * dp - ib / 2; val iby = size - 30 * dp - ib
        g.color = argb(0x99302822); g.fill(Ellipse2D.Float(ibx, iby, ib, ib))
        g.color = ink; g.font = Font(Font.SANS_SERIF, Font.BOLD, (13 * dp).toInt())
        g.fontMetrics.let { fm -> g.drawString("i", ibx + ib / 2 - fm.stringWidth("i") / 2, iby + ib / 2 + fm.ascent / 2 - 2) }
        g.dispose()
        file.parentFile.mkdirs()
        ImageIO.write(img, "png", file)
    }

    private fun step(w: FlyWorld, seconds: Double, stop: (FlyWorld) -> Boolean = { false }): Boolean {
        repeat((seconds * 1000 / FlyWorld.STEP_MS).toInt()) { w.step(); if (stop(w)) return true }
        return false
    }

    @Test
    fun previews() {
        if (out == null || spriteDir == null) return // only when asked for
        val c = loadCircuit()

        // 1. Daytime, a hungry fly wandering.
        val w1 = FlyWorld(c, Pet(satiety = 35.0, energy = 75.0, mood = 60.0), seed = 11)
        step(w1, 2.0) { it.anim == Anim.WALK && it.animTime > 0.4 }
        render(w1, file = File(out, "1-wandering.png"))

        // 2. Sugar dropped; it walks over.
        w1.dropFood(w1.x + 14)
        step(w1, 1.0)
        render(w1, file = File(out, "2-walking-to-food.png"))

        // 3. Its taste neurons drive MN9: proboscis out, drinking.
        step(w1, 12.0) { it.anim == Anim.FEED && it.proboscis > 0.95 }
        render(w1, file = File(out, "3-feeding.png"))

        // 4. A tap on the fly: the Giant Fiber fires and it takes off.
        step(w1, 2.0)
        w1.tap(w1.x - 8)
        step(w1, 2.0) { it.anim == Anim.FLY && it.z > 9 }
        render(w1, file = File(out, "4-escape-flight.png"))

        // 5. A full fly tastes the sugar but MN9 stays quiet: "Not hungry".
        val w5 = FlyWorld(c, Pet(satiety = 92.0, energy = 80.0, mood = 75.0), seed = 3)
        w5.dropFood(4.0)
        step(w5, 12.0) { it.message == "Not hungry" }
        render(w5, file = File(out, "5-not-hungry.png"))

        // 6. Night: asleep.
        val w6 = FlyWorld(c, Pet(satiety = 60.0, energy = 30.0, mood = 55.0), seed = 5)
        w6.setAsleep(true)
        step(w6, 1.3)
        render(w6, night = true, file = File(out, "6-asleep.png"))

        // Animated sequence: feed, drink, get poked, fly off, land.
        val wa = FlyWorld(c, Pet(satiety = 20.0, energy = 70.0, mood = 50.0), seed = 21)
        step(wa, 0.5)
        var frame = 0
        fun film(seconds: Double) = repeat((seconds * 10).toInt()) {
            step(wa, 0.1)
            render(wa, file = File(out, "anim/%04d.png".format(frame++)))
        }
        film(1.0)
        wa.dropFood(wa.x + 12)
        film(5.0)
        wa.tap(wa.x + 6)
        film(3.0)
        println("previews written to $out ($frame animation frames)")
    }
}
