package fly.brain

import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt

/** Neuron-model parameters (the `realistic` preset of flysim/model.py). */
data class LifParams(
    val dt: Double = 0.1, val v0: Double = -52.0, val vReset: Double = -52.0, val vTh: Double = -45.0,
    val tauM: Double = 20.0, val tauSyn: Double = 5.0, val tRef: Double = 2.2, val delay: Double = 1.8,
    val wSyn: Double = 0.275, val fPoi: Double = 250.0, val stpU: Double = 0.2, val tauRec: Double = 500.0,
)

/** The watch circuit: connections stored by presynaptic neuron, plus named neuron groups. */
class Connectome(val indptr: IntArray, val post: IntArray, val w: ShortArray, val groups: Map<String, IntArray>, val params: LifParams) {
    val n get() = indptr.size - 1

    fun group(name: String): IntArray = groups[name] ?: IntArray(0)

    companion object {
        /** Reads brain.bin (little-endian n, e, indptr, post, w) and brain.txt (params and groups). */
        fun read(bin: InputStream, txt: InputStream): Connectome {
            val bb = ByteBuffer.wrap(bin.readBytes()).order(ByteOrder.LITTLE_ENDIAN)
            val n = bb.int
            val e = bb.int
            val indptr = IntArray(n + 1) { bb.int }
            val post = IntArray(e) { bb.int }
            val w = ShortArray(e) { bb.short }
            val groups = HashMap<String, IntArray>()
            val p = HashMap<String, Double>()
            txt.bufferedReader().lineSequence().filter { it.isNotBlank() }.forEach { line ->
                val parts = line.trim().split(" ")
                when (parts[0]) {
                    "param" -> p[parts[1]] = parts[2].toDouble()
                    "group" -> groups[parts[1]] = parts.drop(2).map { it.toInt() }.toIntArray()
                }
            }
            val params = LifParams(
                dt = p["dt"]!!, v0 = p["v0"]!!, vReset = p["v_reset"]!!, vTh = p["v_th"]!!, tauM = p["tau_m"]!!,
                tauSyn = p["tau_syn"]!!, tRef = p["t_ref"]!!, delay = p["delay"]!!, wSyn = p["w_syn"]!!,
                fPoi = p["f_poi"]!!, stpU = p["stp_u"]!!, tauRec = p["tau_rec"]!!,
            )
            return Connectome(indptr, post, w, groups, params)
        }
    }
}

/**
 * Leaky integrate-and-fire network with short-term depression: a port of
 * web/src/brain-engine.js (itself a port of flysim/model.py, Shiu et al. 2024).
 *
 * Event-driven: a neuron is stepped only while it could reach threshold. When the
 * closed-form peak of v (given v, g and no further input) stays below threshold
 * the neuron goes dormant and its state is advanced exactly when input arrives.
 */
class Brain(private val c: Connectome, seed: Int = 1) {
    private val p = c.params
    val n = c.n
    private val d = max(1, (p.delay / p.dt).roundToInt())
    private val refSteps = (p.tRef / p.dt).roundToInt()
    private val decay = exp(-p.dt / p.tauSyn).toFloat()
    private val dtTau = (p.dt / p.tauM).toFloat()
    private val recKeep = 1.0 - p.dt / p.tauRec
    private val kick = (p.fPoi * p.wSyn).toFloat()
    private val bFac = p.tauSyn / (p.tauSyn - p.tauM)
    private val uTh = p.vTh - p.v0 - 0.5
    private val kPeak: Double
    private val expM: DoubleArray
    private val expS: DoubleArray

    private val v = FloatArray(n)
    private val g = FloatArray(n)
    private val ref = ByteArray(n)
    private val x = FloatArray(n)
    private val xStep = IntArray(n)
    private val tLast = IntArray(n)
    private val isActive = BooleanArray(n)
    private val active = IntArray(n)
    private var nActive = 0
    private val buf = Array(d) { FloatArray(n) }
    private val touched = Array(d) { IntArray(2 * n) }
    private val nTouched = IntArray(d)
    private val spk = IntArray(n)
    private val rate = DoubleArray(n)
    private var driveIdx = IntArray(0)
    private var driveP = DoubleArray(0)
    private var dirty = false
    private var rng = if (seed == 0) 1 else seed
    var step = 0
        private set

    val timeMs get() = step * p.dt
    val stepping get() = nActive

    init {
        val tPk = ln(p.tauM / p.tauSyn) / (1 / p.tauSyn - 1 / p.tauM)
        kPeak = -bFac * (exp(-tPk / p.tauM) - exp(-tPk / p.tauSyn))
        val k = (3000 / p.dt).roundToInt()
        expM = DoubleArray(k) { exp(-it * p.dt / p.tauM) }
        expS = DoubleArray(k) { exp(-it * p.dt / p.tauSyn) }
        reset()
    }

    fun reset() {
        v.fill(p.v0.toFloat()); g.fill(0f); ref.fill(0); x.fill(1f); xStep.fill(0); tLast.fill(0)
        isActive.fill(false); nActive = 0
        buf.forEach { it.fill(0f) }; nTouched.fill(0)
        step = 0
    }

    fun setRates(idx: IntArray, hz: Double) {
        for (i in idx) rate[i] = hz
        dirty = true
    }

    fun clearRates() {
        rate.fill(0.0)
        dirty = true
    }

    private fun random(): Double {
        var s = rng
        s = s xor (s shl 13); s = s xor (s ushr 17); s = s xor (s shl 5)
        rng = s
        return (s.toLong() and 0xffffffffL) / 4294967296.0
    }

    private fun catchUp(i: Int, t: Int) {
        val steps = t - 1 - tLast[i]
        if (steps <= 0) return
        val g0 = g[i].toDouble()
        val u0 = v[i] - p.v0
        if (g0 == 0.0 && u0 == 0.0) return
        if (steps >= expM.size) { g[i] = 0f; v[i] = p.v0.toFloat(); return }
        val b = g0 * bFac
        val es = expS[steps]
        g[i] = (g0 * es).toFloat()
        v[i] = (p.v0 + (u0 - b) * expM[steps] + b * es).toFloat()
    }

    private fun activate(i: Int, t: Int) {
        if (isActive[i]) return
        catchUp(i, t)
        isActive[i] = true
        active[nActive++] = i
    }

    private fun canFire(u0: Double, g0: Double): Boolean {
        if (u0 >= uTh) return true
        if (g0 <= 0) return false
        if (max(u0, 0.0) + kPeak * g0 < uTh) return false
        val b = g0 * bFac
        val a = u0 - b
        if (a <= 0) return false
        val r = (-b * p.tauM) / (a * p.tauSyn)
        if (r <= 1) return false
        val ts = ln(r) / (1 / p.tauSyn - 1 / p.tauM)
        return a * exp(-ts / p.tauM) + b * exp(-ts / p.tauSyn) >= uTh
    }

    /** Advance [ms] of simulated time, adding spike counts per neuron into [counts]. */
    fun run(ms: Double, counts: IntArray? = null) {
        if (dirty) {
            val idx = (0 until n).filter { rate[it] > 0 }
            driveIdx = idx.toIntArray()
            driveP = DoubleArray(idx.size) { rate[idx[it]] * p.dt * 1e-3 }
            dirty = false
        }
        val v0 = p.v0.toFloat()
        val vReset = p.vReset.toFloat()
        val vTh = p.vTh.toFloat()
        val wSyn = p.wSyn.toFloat()
        val stpU = p.stpU.toFloat()
        val steps = (ms / p.dt).roundToInt()
        repeat(steps) {
            val t = step++
            val slot = t % d
            val row = buf[slot]
            val tl = touched[slot]
            // Inputs arriving this step: small ones are applied in place to dormant neurons.
            for (k in 0 until nTouched[slot]) {
                val i = tl[k]
                if (isActive[i] || row[i] == 0f) continue
                catchUp(i, t)
                if (ref[i].toInt() == 0) {
                    val gn = g[i] * decay + row[i]
                    val un = v[i] - v0 + dtTau * (gn - (v[i] - v0))
                    if (max(un.toDouble(), 0.0) + kPeak * max(gn.toDouble(), 0.0) < uTh) {
                        g[i] = gn; v[i] = v0 + un; row[i] = 0f; tLast[i] = t
                        continue
                    }
                }
                tLast[i] = t - 1
                activate(i, t)
            }
            nTouched[slot] = 0
            for (k in driveIdx.indices) {
                if (random() < driveP[k]) {
                    val i = driveIdx[k]
                    activate(i, t)
                    g[i] += kick
                }
            }
            var ns = 0
            var keep = 0
            for (k in 0 until nActive) {
                val i = active[k]
                var gi = g[i] * decay + row[i]
                row[i] = 0f
                if (gi < 1e-6f && gi > -1e-6f) gi = 0f
                g[i] = gi
                if (ref[i] > 0) {
                    ref[i] = (ref[i] - 1).toByte()
                } else {
                    var vi = v[i] + dtTau * (gi - (v[i] - v0))
                    if (vi > vTh) { vi = vReset; ref[i] = refSteps.toByte(); spk[ns++] = i }
                    v[i] = vi
                }
                if (ref[i].toInt() == 0 && !canFire((v[i] - v0).toDouble(), gi.toDouble())) {
                    isActive[i] = false
                    tLast[i] = t
                } else {
                    active[keep++] = i
                }
            }
            nActive = keep
            var nT = nTouched[slot]
            for (a in 0 until ns) {
                val j = spk[a]
                if (counts != null) counts[j]++
                var xj = x[j]
                if (xj < 1f) xj = (1.0 - (1.0 - xj) * recKeep.pow(t - xStep[j])).toFloat()
                val scale = wSyn * xj
                x[j] = xj - stpU * xj
                xStep[j] = t
                for (e in c.indptr[j] until c.indptr[j + 1]) {
                    val i = c.post[e]
                    if (row[i] == 0f && nT < tl.size) tl[nT++] = i
                    row[i] += c.w[e] * scale
                }
            }
            nTouched[slot] = nT
        }
    }
}
