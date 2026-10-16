package fly.phone

import android.content.res.AssetManager
import java.io.BufferedInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors

/**
 * A tiny web server for the bundled website (assets/web), on 127.0.0.1 only. A real HTTP
 * origin keeps everything the page needs working as on the web: its module scripts, the
 * brain's Web Worker and its fetches, localStorage for the pet, and Cache Storage. The page's
 * three.js import map and web fonts point online; index.html is rewritten to use the system
 * fonts, and the scripts' "three" imports are rewritten to the copy in the APK (vendor/three),
 * so the game runs offline and does not depend on the WebView supporting import maps.
 */
class LocalServer(private val assets: AssetManager) {
    private var socket: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool()
    var port = 0
        private set

    /** Start on a fixed port (the pet is saved per origin, so it must stay the same). */
    fun start(preferred: Int = 47811): Int {
        val s = try {
            ServerSocket(preferred, 50, InetAddress.getByName("127.0.0.1"))
        } catch (e: Exception) {
            ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")) // taken: any free port
        }
        socket = s
        port = s.localPort
        Thread({
            while (!s.isClosed) {
                val c = try { s.accept() } catch (e: Exception) { break }
                pool.execute { serve(c) }
            }
        }, "site-server").apply { isDaemon = true; start() }
        return port
    }

    fun stop() {
        socket?.close()
        socket = null
    }

    private fun serve(c: Socket) {
        c.use { serveOn(it) }
    }

    private fun serveOn(c: Socket) {
        try {
            val input = BufferedInputStream(c.getInputStream())
            val request = readLine(input) ?: return
            while (true) { val h = readLine(input) ?: break; if (h.isEmpty()) break } // skip headers
            val parts = request.split(" ")
            if (parts.size < 2 || parts[0] != "GET") return respond(c.getOutputStream(), 405, "text/plain", "method".toByteArray())
            var path = parts[1].substringBefore("?").substringBefore("#")
            if (path == "/" || path.isEmpty()) path = "/index.html"
            if (path.contains("..")) return respond(c.getOutputStream(), 404, "text/plain", "not found".toByteArray())
            val name = "web" + path
            val type = TYPES[path.substringAfterLast('.', "")] ?: "application/octet-stream"
            if (path == "/index.html") {
                val html = assets.open(name).use { it.readBytes().decodeToString() }
                    .replace("https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js", "/vendor/three/build/three.module.js")
                    .replace("https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/", "/vendor/three/examples/jsm/")
                    .replace(Regex("""<link rel="(preconnect|stylesheet)" href="https://fonts\.[^"]*"[^>]*>"""), "")
                return respond(c.getOutputStream(), 200, type, html.toByteArray())
            }
            if (path.endsWith(".js") && !path.endsWith("three.module.js")) {
                val js = assets.open(name).use { it.readBytes().decodeToString() }
                    .replace(THREE_ADDONS) { "${it.groupValues[1]}/vendor/three/examples/jsm/${it.groupValues[2]}${it.groupValues[1]}" }
                    .replace(THREE_CORE) { "${it.groupValues[1]}${it.groupValues[2]}/vendor/three/build/three.module.js${it.groupValues[2]}" }
                return respond(c.getOutputStream(), 200, type, js.toByteArray())
            }
            val length = try { assets.openFd(name).use { it.length } } catch (e: Exception) { -1L } // stored (uncompressed) files
            val stream = try { assets.open(name) } catch (e: Exception) {
                return respond(c.getOutputStream(), 404, "text/plain", "not found".toByteArray())
            }
            stream.use { s ->
                if (length >= 0) respondStream(c.getOutputStream(), type, s, length)
                else respond(c.getOutputStream(), 200, type, s.readBytes())
            }
        } catch (e: Exception) {
            // The page closed the connection, or similar: nothing to do.
        }
    }

    private fun header(out: OutputStream, code: Int, type: String, length: Long) {
        val status = when (code) { 200 -> "OK"; 404 -> "Not Found"; else -> "Error" }
        out.write(("HTTP/1.1 $code $status\r\nContent-Type: $type\r\nContent-Length: $length\r\n" +
            "Cache-Control: no-cache\r\nConnection: close\r\n\r\n").toByteArray())
    }

    private fun respond(out: OutputStream, code: Int, type: String, body: ByteArray) {
        header(out, code, type, body.size.toLong())
        out.write(body)
        out.flush()
    }

    private fun respondStream(out: OutputStream, type: String, s: InputStream, length: Long) {
        header(out, 200, type, length)
        s.copyTo(out, 1 shl 16)
        out.flush()
    }

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(b.toChar())
        }
    }

    companion object {
        private val THREE_ADDONS = Regex("""(["'])three/addons/([^"']*)\1""")
        private val THREE_CORE = Regex("""(from\s*)(["'])three\2""")
        private val TYPES = mapOf(
            "html" to "text/html; charset=utf-8", "js" to "text/javascript; charset=utf-8", "mjs" to "text/javascript; charset=utf-8",
            "json" to "application/json", "png" to "image/png", "css" to "text/css", "txt" to "text/plain", "svg" to "image/svg+xml",
        )
    }
}
