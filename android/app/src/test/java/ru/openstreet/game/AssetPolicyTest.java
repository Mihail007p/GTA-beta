package ru.openstreet.game;

/** Runnable on a normal JVM; no Android runtime or network is needed. */
public final class AssetPolicyTest {
    private static void yes(boolean condition, String label) {
        if (!condition) throw new AssertionError(label);
    }
    private static void blocked(String url) { yes(AssetPolicy.assetPath("GET", url) == null, url); }

    public static void main(String[] args) {
        String root = "https://appassets.androidplatform.net/game/";
        yes("game/index.html".equals(AssetPolicy.assetPath("GET", root + "index.html?androidApp=1")), "index");
        yes("game/js/main.js".equals(AssetPolicy.assetPath("GET", root + "js/main.js")), "JS");
        yes("game/assets/cars/cgt.glb".equals(AssetPolicy.assetPath("GET", root + "assets/cars/cgt.glb")), "GLB");
        yes(AssetPolicy.assetPath("POST", root + "index.html") == null, "POST");
        blocked("http://appassets.androidplatform.net/game/index.html");
        blocked("https://appassets.androidplatform.net.evil.example/game/index.html");
        blocked("https://appassets.androidplatform.net@evil.example/game/index.html");
        blocked("https://evil.example/game/index.html");
        blocked("https://appassets.androidplatform.net:444/game/index.html");
        blocked("file:///android_asset/game/index.html");
        blocked(root + "../secret");
        blocked(root + "%2e%2e/secret");
        blocked(root + "a/%2E%2E/secret");
        blocked(root + "a%2f..%2fsecret");
        blocked(root + "%252e%252e/secret");
        blocked(root + "a\\..\\secret");
        blocked(root + "/index.html");
        blocked(root);
        yes("text/javascript".equals(AssetPolicy.mimeType("game/js/main.js")), "js MIME");
        yes("model/gltf-binary".equals(AssetPolicy.mimeType("game/assets/hero.glb")), "glb MIME");
        yes(AssetPolicy.encoding("image/png") == null, "binary encoding");
        yes("UTF-8".equals(AssetPolicy.encoding("application/json")), "json encoding");
        yes(AssetPolicy.isCreditLink("https://sketchfab.com/models/example"), "credit URL");
        yes(!AssetPolicy.isCreditLink("https://sketchfab.com.evil.example/"), "host spoof");
        yes(!AssetPolicy.isCreditLink("https://user@sketchfab.com/"), "userinfo");
        yes(!AssetPolicy.isCreditLink("http://sketchfab.com/"), "cleartext");
        System.out.println("AssetPolicy: all tests passed");
    }
}
