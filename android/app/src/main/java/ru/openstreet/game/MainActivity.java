package ru.openstreet.game;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.DialogInterface;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/** A small offline shell: no JS bridge, local file access, or remote game server. */
public final class MainActivity extends Activity {
    private static final String TAG = "OpenStreet";
    private FrameLayout root;
    private WebView webView;

    // The actual navigation is in game code, where it can be browser-tested.
    private static final String BACK_SCRIPT = "(function(){return window.__openStreetAndroidBack ? " +
            "window.__openStreetAndroidBack() : false;})()";

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        immersive();
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(7, 10, 18));
        setContentView(root);
        installServiceWorkerGuard();
        startGame();
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_FULLSCREEN |
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    private void startGame() {
        WebView w = new WebView(this);
        webView = w;
        w.setBackgroundColor(Color.rgb(7, 10, 18));
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = w.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        w.setWebChromeClient(new WebChromeClient());
        w.setWebViewClient(new GameClient());
        root.removeAllViews();
        root.addView(w, new FrameLayout.LayoutParams(-1, -1));
        w.loadUrl(AssetPolicy.START_URL);
    }

    private void installServiceWorkerGuard() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            // App mode never registers a worker, but block remote requests if an older
            // worker ever exists. All game assets are read directly from the APK.
            try {
                ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                        return localResponse(request.getMethod(), request.getUrl().toString());
                    }
                });
            } catch (RuntimeException e) {
                Log.w(TAG, "Service worker guard unavailable", e);
            }
        }
    }

    private WebResourceResponse localResponse(String method, String url) {
        // data: and blob: are local browser-generated resources used by glTF loaders.
        if (url.startsWith("data:") || url.startsWith("blob:") || url.equals("about:blank")) return null;
        String path = AssetPolicy.assetPath(method, url);
        if (path == null) return errorResponse(403, "Forbidden");
        try {
            InputStream bytes = getAssets().open(path);
            String mime = AssetPolicy.mimeType(path);
            Map<String, String> headers = new HashMap<>();
            // An APK update must never be shadowed by an old HTTP or service-worker cache.
            headers.put("Cache-Control", "no-store");
            headers.put("X-Content-Type-Options", "nosniff");
            return new WebResourceResponse(mime, AssetPolicy.encoding(mime), 200, "OK", headers, bytes);
        } catch (IOException e) {
            Log.w(TAG, "Missing bundled asset: " + path);
            return errorResponse(404, "Not Found");
        }
    }

    private static WebResourceResponse errorResponse(int status, String reason) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", status, reason, headers,
                new ByteArrayInputStream(new byte[0]));
    }

    private boolean navigateOutside(String url, boolean userGesture) {
        if (AssetPolicy.assetPath("GET", url) != null) return false;
        if (userGesture && AssetPolicy.isCreditLink(url)) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(this, "Не найден браузер для открытия ссылки", Toast.LENGTH_LONG).show();
            }
        }
        return true; // Never let the game WebView navigate to external content.
    }

    private final class GameClient extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return localResponse(request.getMethod(), request.getUrl().toString());
        }

        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return navigateOutside(request.getUrl().toString(), request.isForMainFrame() && request.hasGesture());
        }

        @SuppressWarnings("deprecation")
        @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return navigateOutside(url, true); // API 23 has no hasGesture() callback.
        }

        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (view == webView && request.isForMainFrame()) showError("Не удалось открыть встроенные файлы игры.");
        }

        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (view == webView && request.isForMainFrame()) showError("Не удалось открыть встроенные файлы игры.");
        }

        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (view == webView) showError("3D-страница остановилась. Попробуйте закрыть другие приложения и запустить игру снова.");
            return true;
        }
    }

    private void showError(String message) {
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(32, 24, 32, 24);
        TextView text = new TextView(this);
        text.setText(message);
        text.setTextColor(Color.WHITE);
        text.setTextSize(18);
        text.setGravity(Gravity.CENTER);
        Button retry = new Button(this);
        retry.setText("Попробовать снова");
        retry.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { startGame(); }
        });
        panel.addView(text);
        panel.addView(retry);
        root.removeAllViews();
        root.addView(panel, new FrameLayout.LayoutParams(-1, -1));
    }

    @Override public void onBackPressed() {
        if (webView == null) { confirmExit(); return; }
        webView.evaluateJavascript(BACK_SCRIPT, new ValueCallback<String>() {
            @Override public void onReceiveValue(String result) {
                if (!"true".equals(result) && !isFinishing()) confirmExit();
            }
        });
    }

    private void confirmExit() {
        new AlertDialog.Builder(this).setTitle("Выйти из Open Street?")
                .setMessage("Прогресс хранится на этом устройстве.")
                .setNegativeButton("Остаться", null)
                .setPositiveButton("Выйти", new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface dialog, int which) { finish(); }
                }).show();
    }

    @Override protected void onPause() {
        if (webView != null) {
            webView.evaluateJavascript("if(window.__openStreetAndroidPause) window.__openStreetAndroidPause();", null);
            webView.onPause();
        }
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        immersive();
    }

    @Override protected void onDestroy() {
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
