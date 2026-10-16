package fly.brain

import java.io.InputStream
import java.util.zip.Inflater

/**
 * Loads the website's whole-CNS connectome (web/assets: brain.json plus brain-NN.png, written
 * by web/tools/export_brain.py) for the phone app: all 165,122 neurons and 23.4 million
 * connections, with the same neuron groups the website reads. The PNG parts hold one byte
 * stream in three varint sections: out-degree per neuron, target deltas within each row, and
 * zigzag signed weights (see web/src/brain-engine.js: decodeConnectome).
 *
 * Groups match the watch circuit's names (taste, loom.L/R, touch.L/R for the head bristles,
 * motor.<pool>.L/R, with motor.groom = DNg12 and friends) plus the spontaneous sensory
 * background as bg.<Hz> groups.
 */
object WebConnectome {
    fun read(open: (String) -> InputStream): Connectome {
        @Suppress("UNCHECKED_CAST")
        val meta = Json.parse(open("brain.json").use { it.readBytes().decodeToString() }) as Map<String, Any?>
        val n = (meta["n"] as Number).toInt()
        val e = (meta["edges"] as Number).toInt()
        val chunks = (meta["chunks"] as List<*>).map { it as Map<*, *> }
        val src = PayloadReader(chunks.map { ch -> { open(ch["file"] as String).use { it.readBytes() } to (ch["bytes"] as Number).toInt() } })
        val indptr = IntArray(n + 1)
        for (i in 0 until n) indptr[i + 1] = indptr[i] + src.varint().toInt()
        check(indptr[n] == e) { "brain.json says $e edges, rows hold ${indptr[n]}" }
        val post = IntArray(e)
        for (i in 0 until n) {
            var prev = 0
            for (k in indptr[i] until indptr[i + 1]) {
                val d = src.varint().toInt()
                prev = if (k == indptr[i]) d else prev + d
                post[k] = prev
            }
        }
        val w = ShortArray(e)
        for (k in 0 until e) {
            val v = src.varint()
            w[k] = ((v ushr 1) xor -(v and 1)).toInt().toShort()
        }
        @Suppress("UNCHECKED_CAST")
        val p = meta["params"] as Map<String, Any?>
        fun d(k: String) = (p[k] as Number).toDouble()
        val params = LifParams(
            dt = d("dt"), v0 = d("v0"), vReset = d("v_reset"), vTh = d("v_th"), tauM = d("tau_m"), tauSyn = d("tau_syn"),
            tRef = d("t_ref"), delay = d("delay"), wSyn = d("w_syn"), fPoi = d("f_poi"), stpU = d("stp_u"), tauRec = d("tau_rec"),
            adapt = (p["adapt"] as Number?)?.toDouble() ?: 0.0, tauAdapt = (p["tau_adapt"] as Number?)?.toDouble() ?: 200.0,
        )
        return Connectome(indptr, post, w, groups(meta["groups"] as Map<*, *>), params)
    }

    private fun ints(v: Any?) = (v as List<*>).map { (it as Number).toInt() }.toIntArray()

    private fun groups(g: Map<*, *>): Map<String, IntArray> {
        val out = HashMap<String, IntArray>()
        out["taste"] = ints(g["taste"])
        val loom = g["loom"] as Map<*, *>
        out["loom.L"] = ints(loom["L"]); out["loom.R"] = ints(loom["R"])
        val head = (g["touch"] as Map<*, *>)["head"] as Map<*, *>
        out["touch.L"] = ints(head["L"]); out["touch.R"] = ints(head["R"])
        for ((name, sides) in g["motor"] as Map<*, *>) {
            sides as Map<*, *>
            for (s in listOf("L", "R")) out["motor.$name.$s"] = ints(sides[s])
        }
        // The watch circuit calls the head-grooming DNs (DNg12 etc.) "groom".
        for (s in listOf("L", "R")) out["motor.groom.$s"] = out.getValue("motor.groomHead.$s")
        // Spontaneous background, grouped by rate.
        val bg = g["background"] as Map<*, *>
        val idx = ints(bg["idx"])
        val hz = (bg["hz"] as List<*>).map { (it as Number).toDouble() }
        idx.indices.groupBy { hz[it] }.forEach { (rate, ks) -> out["bg.$rate"] = IntArray(ks.size) { idx[ks[it]] } }
        return out
    }

    /** The concatenated payload bytes of the PNG parts, read one part at a time. */
    private class PayloadReader(private val parts: List<() -> Pair<ByteArray, Int>>) {
        private var next = 0
        private var buf = ByteArray(0)
        private var pos = 0

        fun byte(): Int {
            while (pos >= buf.size) {
                check(next < parts.size) { "connectome stream ended early" }
                val (png, length) = parts[next++]()
                buf = decodePng(png, length)
                pos = 0
            }
            return buf[pos++].toInt() and 0xFF
        }

        fun varint(): Long {
            var v = 0L
            var shift = 0
            while (true) {
                val b = byte()
                v = v or ((b and 0x7F).toLong() shl shift)
                if (b and 0x80 == 0) return v
                shift += 7
            }
        }
    }

    /** Bytes stored in a grayscale PNG by web/tools/pngpack.py (filter type 0 on every row). */
    fun decodePng(png: ByteArray, length: Int): ByteArray {
        var pos = 8
        var width = 0
        val inflater = Inflater()
        val out = ByteArray(length)
        var o = 0
        var rowLeft = 0          // payload bytes left in the current row; 0 = the next byte is a filter byte
        val tmp = ByteArray(1 shl 16)
        fun drain() {
            while (true) {
                val k = inflater.inflate(tmp)
                if (k == 0) break
                for (i in 0 until k) {
                    if (rowLeft == 0) { rowLeft = width; continue } // filter byte
                    if (o < length) out[o++] = tmp[i]
                    rowLeft--
                }
            }
        }
        while (pos + 8 <= png.size) {
            val len = ((png[pos].toInt() and 0xFF) shl 24) or ((png[pos + 1].toInt() and 0xFF) shl 16) or
                ((png[pos + 2].toInt() and 0xFF) shl 8) or (png[pos + 3].toInt() and 0xFF)
            val kind = String(png, pos + 4, 4, Charsets.US_ASCII)
            if (kind == "IHDR") {
                width = ((png[pos + 8].toInt() and 0xFF) shl 24) or ((png[pos + 9].toInt() and 0xFF) shl 16) or
                    ((png[pos + 10].toInt() and 0xFF) shl 8) or (png[pos + 11].toInt() and 0xFF)
            } else if (kind == "IDAT") {
                inflater.setInput(png, pos + 8, len)
                drain()
            }
            pos += 12 + len
        }
        inflater.end()
        check(o == length) { "PNG held $o of $length bytes" }
        return out
    }
}

/** A small JSON reader (objects, arrays, numbers, strings, true/false/null). */
internal object Json {
    fun parse(s: String): Any? = Parser(s).run { val v = value(); ws(); v }

    private class Parser(val s: String) {
        var i = 0
        fun ws() { while (i < s.length && s[i].isWhitespace()) i++ }
        fun value(): Any? {
            ws()
            return when (s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> { i += 4; true }
                'f' -> { i += 5; false }
                'n' -> { i += 4; null }
                else -> num()
            }
        }
        fun obj(): Map<String, Any?> {
            val m = LinkedHashMap<String, Any?>()
            i++; ws()
            if (s[i] == '}') { i++; return m }
            while (true) {
                ws(); val k = str(); ws(); i++ // ':'
                m[k] = value(); ws()
                if (s[i++] == '}') return m
            }
        }
        fun arr(): List<Any?> {
            val a = ArrayList<Any?>()
            i++; ws()
            if (s[i] == ']') { i++; return a }
            while (true) {
                a += value(); ws()
                if (s[i++] == ']') return a
            }
        }
        fun str(): String {
            val b = StringBuilder()
            i++ // opening quote
            while (s[i] != '"') {
                if (s[i] == '\\') {
                    i++
                    when (s[i]) {
                        'n' -> b.append('\n')
                        't' -> b.append('\t')
                        'r' -> b.append('\r')
                        'b' -> b.append('\b')
                        'f' -> b.append('\u000c')
                        'u' -> { b.append(s.substring(i + 1, i + 5).toInt(16).toChar()); i += 4 }
                        else -> b.append(s[i])
                    }
                } else b.append(s[i])
                i++
            }
            i++
            return b.toString()
        }
        fun num(): Number {
            val st = i
            while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
            val t = s.substring(st, i)
            return if (t.any { it in ".eE" }) t.toDouble() else t.toLong()
        }
    }
}
