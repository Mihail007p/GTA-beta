package ru.openstreet.game;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.regex.Pattern;

/** The WebView can read only bundled assets under a fixed, stable HTTPS origin. */
final class AssetPolicy {
    static final String HOST = "appassets.androidplatform.net";
    static final String START_URL = "https://" + HOST + "/game/index.html?androidApp=1";
    private static final Pattern SAFE_PATH = Pattern.compile("[A-Za-z0-9_./-]+");

    private AssetPolicy() { }

    static String assetPath(String method, String url) {
        if (!"GET".equals(method) || url == null) return null;
        try {
            URI uri = new URI(url);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || !HOST.equalsIgnoreCase(uri.getHost())
                    || uri.getUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)) return null;
            String path = uri.getPath(); // URI decodes percent escapes before the traversal check.
            if (path == null || !path.startsWith("/game/") || !SAFE_PATH.matcher(path).matches()) return null;
            String[] parts = path.substring(1).split("/", -1);
            for (String part : parts) {
                if (part.isEmpty() || ".".equals(part) || "..".equals(part)) return null;
            }
            return path.substring(1);
        } catch (URISyntaxException | IllegalArgumentException e) {
            return null;
        }
    }

    /** Only explicitly linked credit sites can open in a separate browser. */
    static boolean isCreditLink(String url) {
        try {
            URI uri = new URI(url);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null
                    || (uri.getPort() != -1 && uri.getPort() != 443) || uri.getHost() == null) return false;
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            return host.equals("sketchfab.com") || host.equals("creativecommons.org")
                    || host.equals("github.com") || host.equals("rgsdev.itch.io")
                    || host.equals("opengameart.org");
        } catch (URISyntaxException | IllegalArgumentException e) {
            return false;
        }
    }

    static String mimeType(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".glb")) return "model/gltf-binary";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".txt") || p.endsWith(".md")) return "text/plain";
        return "application/octet-stream";
    }

    static String encoding(String mime) {
        return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml")
                ? "UTF-8" : null;
    }
}
