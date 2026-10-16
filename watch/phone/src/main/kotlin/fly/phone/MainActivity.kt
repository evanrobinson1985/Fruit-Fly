package fly.phone

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Feed the Fly on a phone: the website's game mode (index.html?game) full screen in a
 * WebView. Same 3D fly, grass arena, sky, sounds and whole-CNS brain as the website; the
 * pet is saved by the page (localStorage) and keeps living while the app is closed.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private val server by lazy { LocalServer(assets) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val port = server.start()
        WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect from a computer, if it misbehaves
        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0d0c0a"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true            // the pet lives in localStorage
            settings.mediaPlaybackRequiresUserGesture = false
            settings.setSupportZoom(false)
            overScrollMode = View.OVER_SCROLL_NEVER
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    Log.i("FlyPage", "${m.messageLevel()} ${m.sourceId()}:${m.lineNumber()} ${m.message()}")
                    return true
                }
            }
            webViewClient = object : WebViewClient() {
                // Stay inside the game: links (credits, sources) open in the browser.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url
                    if (url.host == "127.0.0.1") return false
                    startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, url))
                    return true
                }
            }
        }
        setContentView(web)
        immersive()
        if (savedInstanceState == null) web.loadUrl("http://127.0.0.1:$port/index.html?game")
        else web.restoreState(savedInstanceState)
    }

    private fun immersive() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        web.resumeTimers()
    }

    override fun onPause() {
        web.onPause()          // the page saves the pet on visibilitychange
        web.pauseTimers()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        server.stop()
        super.onDestroy()
    }
}
