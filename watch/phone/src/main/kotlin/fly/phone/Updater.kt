package fly.phone

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Updates from the "phone-latest" GitHub release, which every build of the app publishes
 * (.github/workflows/watch-apk.yml): at launch the app reads the release's version number
 * and, if it's newer than its own, offers the new APK. On "Update" it downloads it and
 * opens Android's installer (Android always asks you to confirm an install; the first
 * time it also asks you to allow installs from Feed the Fly). Offline, nothing happens.
 */
class Updater(private val activity: Activity) {
    private val base = "https://github.com/evanrobinson1985/Fruit-Fly/releases/download/phone-latest"

    fun check() {
        Thread {
            val latest = try { fetch("$base/phone-version.txt").decodeToString().trim().toLong() } catch (e: Exception) { return@Thread }
            val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
            if (latest <= PackageInfoCompat.getLongVersionCode(info)) return@Thread
            activity.runOnUiThread { offer() }
        }.apply { isDaemon = true }.start()
    }

    private fun offer() {
        if (activity.isFinishing) return
        AlertDialog.Builder(activity)
            .setTitle("Update available")
            .setMessage("A new version of Feed the Fly is ready. Download and install it now?")
            .setPositiveButton("Update") { _, _ -> download() }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun download() {
        val progress = AlertDialog.Builder(activity)
            .setTitle("Updating Feed the Fly")
            .setMessage("Downloading…")
            .setCancelable(false)
            .show()
        Thread {
            try {
                val dir = File(activity.cacheDir, "updates").apply { mkdirs() }
                val apk = File(dir, "feed-the-fly-phone.apk")
                download("$base/feed-the-fly-phone.apk", apk) { pct ->
                    activity.runOnUiThread { progress.setMessage("Downloading… $pct%") }
                }
                activity.runOnUiThread {
                    progress.dismiss()
                    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", apk)
                    activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, "application/vnd.android.package-archive")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    })
                }
            } catch (e: Exception) {
                activity.runOnUiThread {
                    progress.dismiss()
                    AlertDialog.Builder(activity).setTitle("Update failed")
                        .setMessage("Couldn't download the update (${e.message}). It will be offered again next time.")
                        .setPositiveButton("OK", null).show()
                }
            }
        }.apply { isDaemon = true }.start()
    }

    private fun open(url: String): HttpURLConnection {
        // GitHub redirects release downloads to its file host (https -> https: followed).
        var u = URL(url)
        repeat(5) {
            val c = (u.openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000; readTimeout = 20000; instanceFollowRedirects = false
            }
            val code = c.responseCode
            if (code in 300..399) { u = URL(u, c.getHeaderField("Location")); c.disconnect() } else {
                if (code != 200) { c.disconnect(); throw IllegalStateException("HTTP $code") }
                return c
            }
        }
        throw IllegalStateException("too many redirects")
    }

    private fun fetch(url: String): ByteArray = open(url).let { c -> try { c.inputStream.use { it.readBytes() } } finally { c.disconnect() } }

    private fun download(url: String, to: File, onProgress: (Int) -> Unit) {
        val c = open(url)
        try {
            val total = c.contentLengthLong
            var done = 0L
            var last = -1
            c.inputStream.use { input ->
                to.outputStream().use { out ->
                    val buf = ByteArray(1 shl 16)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        val pct = if (total > 0) (done * 100 / total).toInt() else 0
                        if (pct != last) { last = pct; onProgress(pct) }
                    }
                }
            }
        } finally { c.disconnect() }
    }
}
