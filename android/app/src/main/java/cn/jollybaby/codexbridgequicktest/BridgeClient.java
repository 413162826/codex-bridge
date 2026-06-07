package cn.jollybaby.codexbridgequicktest;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class BridgeClient {
    static final String USER_AGENT = "CodexBridge/0.2.2 AndroidHttp";
    private static final Pattern MARKDOWN_IMAGE_PATTERN = Pattern.compile("!\\[[^\\]]*]\\((https?://[^)\\s]+)\\)", Pattern.CASE_INSENSITIVE);
    private static final Pattern PLAIN_IMAGE_URL_PATTERN = Pattern.compile("https?://[^\\s)]+\\.(?:png|jpe?g|webp|gif)(?:\\?[^\\s)]*)?", Pattern.CASE_INSENSITIVE);
    private static final Pattern WINDOWS_IMAGE_PATH_PATTERN = Pattern.compile("([A-Z]:\\\\[^\\r\\n<>\"|?*]+?\\.(?:png|jpe?g|webp|gif))", Pattern.CASE_INSENSITIVE);

    private final String baseUrl;
    private final String accessKey;

    BridgeClient(String baseUrl) {
        this(baseUrl, "");
    }

    BridgeClient(String baseUrl, String accessKey) {
        this.baseUrl = normalizeBaseUrl(baseUrl);
        this.accessKey = accessKey == null ? "" : accessKey.trim();
    }

    static String normalizeBaseUrl(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            return "";
        }
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "http://" + value;
        }
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    static boolean isLoopbackHost(String raw) {
        String value = normalizeBaseUrl(raw).toLowerCase(Locale.ROOT);
        return value.contains("://127.") || value.contains("://localhost") || value.contains("://0.0.0.0");
    }

    static List<String> subnetCandidates(String ipv4, int port) {
        List<String> candidates = new ArrayList<>();
        if (ipv4 == null || ipv4.trim().isEmpty()) {
            return candidates;
        }
        String[] parts = ipv4.trim().split("\\.");
        if (parts.length != 4) {
            return candidates;
        }
        String prefix = parts[0] + "." + parts[1] + "." + parts[2] + ".";
        for (int i = 1; i <= 254; i++) {
            String candidateIp = prefix + i;
            if (!candidateIp.equals(ipv4)) {
                candidates.add("http://" + candidateIp + ":" + port);
            }
        }
        return candidates;
    }

    static JSONObject buildCreateSessionBody(String appId, String name) throws Exception {
        JSONObject body = new JSONObject();
        body.put("name", name == null || name.trim().isEmpty() ? "Android Codex" : name.trim());
        body.put("appId", appId == null ? "" : appId.trim());
        body.put("ephemeral", false);
        body.put("persistExtendedHistory", true);
        body.put("effort", "low");
        body.put("approvalPolicy", "never");
        body.put("sandbox", "workspace-write");
        return body;
    }

    static JSONObject buildTurnBody(String text, List<InputPart> extraInputs) throws Exception {
        JSONArray input = new JSONArray();
        input.put(new JSONObject()
            .put("type", "text")
            .put("text", text == null ? "" : text)
            .put("text_elements", new JSONArray()));
        for (InputPart part : extraInputs == null ? Collections.<InputPart>emptyList() : extraInputs) {
            input.put(part.toJson());
        }
        return new JSONObject()
            .put("input", input)
            .put("effort", "low");
    }

    static List<SessionSummary> parseSessionSummaries(JSONObject json) {
        JSONArray data = json == null ? null : json.optJSONArray("data");
        List<SessionSummary> sessions = new ArrayList<>();
        if (data == null) {
            return sessions;
        }
        for (int i = 0; i < data.length(); i++) {
            JSONObject item = data.optJSONObject(i);
            if (item != null) {
                sessions.add(SessionSummary.fromJson(item));
            }
        }
        return sessions;
    }

    static SessionDetail parseSessionDetail(JSONObject json) {
        JSONObject session = json == null ? null : json.optJSONObject("session");
        if (session == null) {
            return new SessionDetail("", "", "", Collections.emptyList());
        }
        List<ChatMessage> messages = new ArrayList<>();
        JSONArray rawMessages = session.optJSONArray("messages");
        if (rawMessages != null) {
            for (int i = 0; i < rawMessages.length(); i++) {
                JSONObject item = rawMessages.optJSONObject(i);
                if (item != null) {
                    messages.add(ChatMessage.fromJson(item));
                }
            }
        }
        return new SessionDetail(
            session.optString("id"),
            session.optString("name"),
            session.optString("status"),
            messages
        );
    }

    static List<String> extractImageUrls(String text) {
        Set<String> urls = new LinkedHashSet<>();
        String value = text == null ? "" : text;
        Matcher markdown = MARKDOWN_IMAGE_PATTERN.matcher(value);
        while (markdown.find()) {
            urls.add(trimTrailingPunctuation(markdown.group(1)));
        }
        Matcher plain = PLAIN_IMAGE_URL_PATTERN.matcher(value);
        while (plain.find()) {
            urls.add(trimTrailingPunctuation(plain.group()));
        }
        return new ArrayList<>(urls);
    }

    static List<String> extractLocalImagePaths(String text) {
        Set<String> paths = new LinkedHashSet<>();
        String value = text == null ? "" : text;
        Matcher windowsPath = WINDOWS_IMAGE_PATH_PATTERN.matcher(value);
        while (windowsPath.find()) {
            paths.add(trimTrailingPunctuation(windowsPath.group(1)));
        }
        return new ArrayList<>(paths);
    }

    static String sessionFileUrl(String baseUrl, String sessionId, String localPath) {
        String encodedSession = urlEncode(sessionId == null ? "" : sessionId);
        String encodedPath = urlEncode(localPath == null ? "" : localPath);
        return normalizeBaseUrl(baseUrl) + "/api/sessions/" + encodedSession + "/files?path=" + encodedPath;
    }

    HealthResult health() throws Exception {
        return health(20000);
    }

    HealthResult health(int timeoutMs) throws Exception {
        JSONObject json = request("GET", "/api/health", null, timeoutMs);
        JSONObject bridge = json.optJSONObject("bridge");
        JSONObject server = bridge == null ? null : bridge.optJSONObject("server");
        JSONObject codex = json.optJSONObject("codex");
        return new HealthResult(
            json.optBoolean("ok"),
            server == null ? "" : server.optString("host"),
            server == null ? 0 : server.optInt("port"),
            codex != null && codex.optBoolean("started"),
            codex == null ? 0 : codex.optInt("pid")
        );
    }

    String createAppId() throws Exception {
        JSONObject body = new JSONObject();
        body.put("name", "android-quick-test");
        JSONObject json = request("POST", "/api/apps", body, 10000);
        JSONObject app = json.optJSONObject("app");
        if (app == null || app.optString("appId").isEmpty()) {
            throw new IOException("Bridge 没有返回 appId");
        }
        return app.optString("appId");
    }

    String createSession(String appId) throws Exception {
        return createSession(appId, "Android Codex");
    }

    String createSession(String appId, String name) throws Exception {
        JSONObject body = buildCreateSessionBody(appId, name);
        JSONObject json = request("POST", "/api/sessions", body, 30000);
        JSONObject session = json.optJSONObject("session");
        if (session == null || session.optString("id").isEmpty()) {
            throw new IOException("Bridge 没有返回 session id");
        }
        return session.optString("id");
    }

    List<SessionSummary> listSessions() throws Exception {
        return parseSessionSummaries(request("GET", "/api/sessions", null, 20000));
    }

    SessionDetail getSession(String sessionId) throws Exception {
        return parseSessionDetail(request("GET", "/api/sessions/" + urlEncode(sessionId), null, 20000));
    }

    String sendTurnWait(String sessionId, String text) throws Exception {
        return sendTurnWait(sessionId, text, Collections.emptyList());
    }

    String sendTurnWait(String sessionId, String text, List<InputPart> extraInputs) throws Exception {
        JSONObject body = buildTurnBody(text, extraInputs);
        JSONObject json = request("POST", "/api/sessions/" + sessionId + "/turns?wait=1", body, 180000);
        JSONObject session = json.optJSONObject("session");
        if (session == null) {
            return "";
        }
        JSONArray messages = session.optJSONArray("messages");
        if (messages == null) {
            return "";
        }
        for (int i = messages.length() - 1; i >= 0; i--) {
            JSONObject item = messages.optJSONObject(i);
            if (item != null && "assistant".equals(item.optString("role"))) {
                return item.optString("text");
            }
        }
        return "";
    }

    UploadResult uploadImage(String appId, String fileName, String mimeType, String base64) throws Exception {
        JSONObject body = new JSONObject();
        body.put("appId", appId);
        body.put("fileName", fileName);
        body.put("mimeType", mimeType);
        body.put("base64", base64);
        JSONObject json = request("POST", "/api/uploads/images", body, 60000);
        JSONObject upload = json.optJSONObject("upload");
        if (upload == null) {
            throw new IOException("Bridge 没有返回上传结果");
        }
        JSONObject input = upload.optJSONObject("input");
        if (input == null || input.optString("path").isEmpty()) {
            throw new IOException("Bridge 没有返回 localImage 路径");
        }
        return new UploadResult(
            upload.optString("fileName"),
            upload.optString("mimeType"),
            upload.optLong("size"),
            input.optString("path"),
            InputPart.localImage(input.optString("path"))
        );
    }

    void interruptSession(String sessionId) throws Exception {
        request("POST", "/api/sessions/" + urlEncode(sessionId) + "/interrupt", new JSONObject(), 10000);
    }

    void resumeSession(String sessionId) throws Exception {
        request("POST", "/api/sessions/" + urlEncode(sessionId) + "/resume", new JSONObject(), 30000);
    }

    private JSONObject request(String method, String path, JSONObject body, int timeoutMs) throws Exception {
        URL url = new URL(baseUrl + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(timeoutMs);
        connection.setReadTimeout(timeoutMs);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", USER_AGENT);
        if (!accessKey.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + accessKey);
            connection.setRequestProperty("X-Codex-App-Id", accessKey);
        }
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(connection.getOutputStream(), StandardCharsets.UTF_8))) {
                writer.write(body.toString());
            }
        }

        int code = connection.getResponseCode();
        String text = readAll(code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream());
        if (code < 200 || code >= 300) {
            String message = text;
            try {
                JSONObject errorJson = new JSONObject(text).optJSONObject("error");
                if (errorJson != null) {
                    message = errorJson.optString("message", message);
                }
            } catch (Exception ignored) {
                // 保留原始响应文本。
            }
            throw new IOException(message == null || message.isEmpty() ? "HTTP " + code : message);
        }
        return new JSONObject(text);
    }

    private static String readAll(InputStream stream) throws IOException {
        if (stream == null) {
            return "";
        }
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
        }
        return builder.toString();
    }

    private static String urlEncode(String value) {
        return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8);
    }

    private static String trimTrailingPunctuation(String value) {
        String result = value == null ? "" : value.trim();
        while (result.endsWith(".") || result.endsWith(",") || result.endsWith(";") || result.endsWith(":")) {
            result = result.substring(0, result.length() - 1);
        }
        return result;
    }

    static final class InputPart {
        final String type;
        final String path;
        final String url;

        private InputPart(String type, String path, String url) {
            this.type = type;
            this.path = path;
            this.url = url;
        }

        static InputPart localImage(String path) {
            return new InputPart("localImage", path, "");
        }

        static InputPart imageUrl(String url) {
            return new InputPart("image", "", url);
        }

        JSONObject toJson() throws Exception {
            JSONObject json = new JSONObject().put("type", type);
            if ("localImage".equals(type)) {
                json.put("path", path);
            } else if ("image".equals(type)) {
                json.put("url", url);
            }
            return json;
        }
    }

    static final class UploadResult {
        final String fileName;
        final String mimeType;
        final long size;
        final String localPath;
        final InputPart inputPart;

        UploadResult(String fileName, String mimeType, long size, String localPath, InputPart inputPart) {
            this.fileName = fileName;
            this.mimeType = mimeType;
            this.size = size;
            this.localPath = localPath;
            this.inputPart = inputPart;
        }
    }

    static final class SessionSummary {
        final String id;
        final String name;
        final String status;
        final int messageCount;
        final String updatedAt;
        final String lastMessageText;

        SessionSummary(String id, String name, String status, int messageCount, String updatedAt, String lastMessageText) {
            this.id = id;
            this.name = name;
            this.status = status;
            this.messageCount = messageCount;
            this.updatedAt = updatedAt;
            this.lastMessageText = lastMessageText;
        }

        static SessionSummary fromJson(JSONObject item) {
            JSONObject lastMessage = item.optJSONObject("lastMessage");
            return new SessionSummary(
                item.optString("id"),
                item.optString("name", item.optString("id")),
                item.optString("status"),
                item.optInt("messageCount"),
                item.optString("updatedAt"),
                lastMessage == null ? "" : lastMessage.optString("text")
            );
        }
    }

    static final class SessionDetail {
        final String id;
        final String name;
        final String status;
        final List<ChatMessage> messages;

        SessionDetail(String id, String name, String status, List<ChatMessage> messages) {
            this.id = id;
            this.name = name;
            this.status = status;
            this.messages = messages;
        }
    }

    static final class ChatMessage {
        final String role;
        final String text;
        final List<String> imageUrls;
        final List<String> localImagePaths;

        ChatMessage(String role, String text, List<String> imageUrls, List<String> localImagePaths) {
            this.role = role;
            this.text = text;
            this.imageUrls = imageUrls;
            this.localImagePaths = localImagePaths;
        }

        static ChatMessage fromJson(JSONObject item) {
            String text = item.optString("text");
            return new ChatMessage(
                item.optString("role"),
                text,
                extractImageUrls(text),
                extractLocalImagePaths(text)
            );
        }
    }

    static final class HealthResult {
        final boolean ok;
        final String host;
        final int port;
        final boolean codexStarted;
        final int pid;

        HealthResult(boolean ok, String host, int port, boolean codexStarted, int pid) {
            this.ok = ok;
            this.host = host;
            this.port = port;
            this.codexStarted = codexStarted;
            this.pid = pid;
        }
    }
}
