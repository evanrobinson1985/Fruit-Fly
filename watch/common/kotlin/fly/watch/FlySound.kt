package fly.watch

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin

/**
 * The fly's sounds, synthesized like the website's (web/src/audio.js), no recordings: the
 * wingbeat buzz in flight (~210 Hz with harmonics; Bennet-Clark & Ewing 1969 measured
 * 200-220 Hz in D. melanogaster), and soft rubbing while it grooms. A small AudioTrack is
 * fed from its own thread; the screen sets what it should play with [set].
 */
class FlySound(context: Context) {
    private val prefs = context.getSharedPreferences("sound", Context.MODE_PRIVATE)
    var enabled: Boolean = prefs.getBoolean("on", true)
        set(v) { field = v; prefs.edit().putBoolean("on", v).apply() }

    @Volatile private var wingTarget = 0.0
    @Volatile private var groomTarget = 0.0
    @Volatile private var running = false
    private var thread: Thread? = null

    /** wing, groom: 0 (silent) to 1. */
    fun set(wing: Double, groom: Double) {
        wingTarget = if (enabled) wing else 0.0
        groomTarget = if (enabled) groom else 0.0
    }

    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "fly-sound").apply { isDaemon = true; start() }
    }

    fun stop() {
        running = false
        thread?.join(500)
        thread = null
    }

    private fun loop() {
        val rate = 22050
        val minBuf = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val track = try {
            AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(maxOf(minBuf, 2048 * 2))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } catch (e: Exception) { running = false; return }
        track.play()
        val buf = ShortArray(512)
        var phase = 0.0; var wob = 0.0; var t = 0.0
        var wing = 0.0; var groom = 0.0; var lp = 0.0; var hp = 0.0; var prev = 0.0
        val smooth = 1 - exp(-1.0 / (0.03 * rate)) // ~30 ms fades, no clicks
        val rnd = java.util.Random()
        while (running) {
            for (i in buf.indices) {
                wing += (wingTarget - wing) * smooth
                groom += (groomTarget - groom) * smooth
                wob += 2 * PI * 3.1 / rate
                phase += (210.0 + 4 * sin(wob)) / rate
                phase -= phase.toInt()
                // Sawtooth wingbeat, low-passed so it hums rather than rasps.
                lp += (2 * phase - 1 - lp) * 0.35
                var s = 0.22 * wing * lp
                if (groom > 0.001) {
                    // Band-limited noise, gated at the legs' rub rate (~5 strokes a second).
                    t += 1.0 / rate
                    val n = rnd.nextGaussian()
                    hp = 0.6 * (hp + n - prev); prev = n
                    s += 0.05 * groom * hp * (0.5 + 0.5 * sin(2 * PI * 5 * t))
                }
                buf[i] = (s.coerceIn(-1.0, 1.0) * 32000).toInt().toShort()
            }
            track.write(buf, 0, buf.size)
        }
        track.stop()
        track.release()
    }
}
