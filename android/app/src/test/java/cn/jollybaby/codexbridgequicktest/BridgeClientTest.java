package cn.jollybaby.codexbridgequicktest;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class BridgeClientTest {
    @Test
    public void normalizeBaseUrlAddsSchemeAndRemovesTrailingSlash() {
        assertEquals("http://192.168.1.8:4555", BridgeClient.normalizeBaseUrl(" 192.168.1.8:4555/ "));
    }

    @Test
    public void userAgentIsNonBrowserForLocaltunnel() {
        assertTrue(BridgeClient.USER_AGENT.startsWith("CodexBridge/"));
        assertFalse(BridgeClient.USER_AGENT.contains("Mozilla"));
    }

    @Test
    public void loopbackHostIsRejectedForPhoneConnection() {
        assertTrue(BridgeClient.isLoopbackHost("http://127.0.0.1:4555"));
        assertTrue(BridgeClient.isLoopbackHost("localhost:4555"));
        assertTrue(BridgeClient.isLoopbackHost("http://0.0.0.0:4555"));
        assertFalse(BridgeClient.isLoopbackHost("http://192.168.1.8:4555"));
    }

    @Test
    public void subnetCandidatesSkipCurrentPhoneIp() {
        List<String> candidates = BridgeClient.subnetCandidates("192.168.2.35", 4555);

        assertEquals(253, candidates.size());
        assertTrue(candidates.contains("http://192.168.2.1:4555"));
        assertFalse(candidates.contains("http://192.168.2.35:4555"));
        assertTrue(candidates.contains("http://192.168.2.254:4555"));
    }

    @Test
    public void createSessionBodyDefaultsToPersistentConversation() throws Exception {
        JSONObject body = BridgeClient.buildCreateSessionBody("app-123", "手机会话");

        assertEquals("app-123", body.getString("appId"));
        assertEquals("手机会话", body.getString("name"));
        assertFalse(body.getBoolean("ephemeral"));
        assertTrue(body.getBoolean("persistExtendedHistory"));
    }

    @Test
    public void turnBodyIncludesTextAndLocalImageInput() throws Exception {
        BridgeClient.InputPart image = BridgeClient.InputPart.localImage("D:\\workspace\\uploads\\a.png");

        JSONObject body = BridgeClient.buildTurnBody("这张图里有什么？", java.util.Collections.singletonList(image));
        JSONArray input = body.getJSONArray("input");

        assertEquals(2, input.length());
        assertEquals("text", input.getJSONObject(0).getString("type"));
        assertEquals("这张图里有什么？", input.getJSONObject(0).getString("text"));
        assertEquals("localImage", input.getJSONObject(1).getString("type"));
        assertEquals("D:\\workspace\\uploads\\a.png", input.getJSONObject(1).getString("path"));
    }

    @Test
    public void parseSessionSummariesReadsBridgeListResponse() throws Exception {
        JSONObject json = new JSONObject()
            .put("data", new JSONArray()
                .put(new JSONObject()
                    .put("id", "s1")
                    .put("name", "第一段")
                    .put("status", "ready")
                    .put("messageCount", 3)
                    .put("updatedAt", "2026-06-06T10:00:00Z")
                    .put("lastMessage", new JSONObject().put("text", "最近回复"))));

        List<BridgeClient.SessionSummary> sessions = BridgeClient.parseSessionSummaries(json);

        assertEquals(1, sessions.size());
        assertEquals("s1", sessions.get(0).id);
        assertEquals("第一段", sessions.get(0).name);
        assertEquals("最近回复", sessions.get(0).lastMessageText);
    }

    @Test
    public void parseSessionDetailReadsMessages() throws Exception {
        JSONObject json = new JSONObject()
            .put("session", new JSONObject()
                .put("id", "s1")
                .put("name", "图像会话")
                .put("status", "ready")
                .put("messages", new JSONArray()
                    .put(new JSONObject().put("role", "user").put("text", "画图"))
                    .put(new JSONObject().put("role", "assistant").put("text", "![图](https://example.com/a.png)"))));

        BridgeClient.SessionDetail detail = BridgeClient.parseSessionDetail(json);

        assertEquals("s1", detail.id);
        assertEquals(2, detail.messages.size());
        assertEquals("assistant", detail.messages.get(1).role);
        assertEquals("https://example.com/a.png", detail.messages.get(1).imageUrls.get(0));
    }

    @Test
    public void extractImageUrlsFindsMarkdownAndPlainImageLinks() {
        List<String> urls = BridgeClient.extractImageUrls("![成品](https://example.com/a.png)\n备份 https://cdn.example.com/b.webp");

        assertEquals(2, urls.size());
        assertEquals("https://example.com/a.png", urls.get(0));
        assertEquals("https://cdn.example.com/b.webp", urls.get(1));
    }

    @Test
    public void extractLocalImagePathsFindsWindowsGeneratedFiles() {
        List<String> paths = BridgeClient.extractLocalImagePaths("已生成：D:\\Program Files\\dev-project\\demo\\out image.png\n请查看。");

        assertEquals(1, paths.size());
        assertEquals("D:\\Program Files\\dev-project\\demo\\out image.png", paths.get(0));
    }

    @Test
    public void interruptSessionPostsToBridgeWithAppIdHeaders() throws Exception {
        AtomicReference<String> method = new AtomicReference<>("");
        AtomicReference<String> path = new AtomicReference<>("");
        AtomicReference<String> authorization = new AtomicReference<>("");
        AtomicReference<String> appIdHeader = new AtomicReference<>("");
        ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        Thread serverThread = new Thread(() -> {
            try (Socket socket = server.accept();
                 BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                 OutputStreamWriter writer = new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8)) {
                String requestLine = reader.readLine();
                if (requestLine != null) {
                    String[] parts = requestLine.split(" ");
                    method.set(parts[0]);
                    path.set(parts[1]);
                }
                String line;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {
                    String lower = line.toLowerCase(java.util.Locale.ROOT);
                    if (lower.startsWith("authorization:")) {
                        authorization.set(line.substring(line.indexOf(':') + 1).trim());
                    }
                    if (lower.startsWith("x-codex-app-id:")) {
                        appIdHeader.set(line.substring(line.indexOf(':') + 1).trim());
                    }
                }
                String body = "{\"ok\":true}";
                writer.write("HTTP/1.1 200 OK\r\n");
                writer.write("Content-Type: application/json\r\n");
                writer.write("Content-Length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\n");
                writer.write("\r\n");
                writer.write(body);
                writer.flush();
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        });
        serverThread.start();
        try {
            int port = server.getLocalPort();
            new BridgeClient("http://127.0.0.1:" + port, "app-123").interruptSession("session-1");
            serverThread.join(2000);

            assertEquals("POST", method.get());
            assertEquals("/api/sessions/session-1/interrupt", path.get());
            assertEquals("Bearer app-123", authorization.get());
            assertEquals("app-123", appIdHeader.get());
        } finally {
            server.close();
        }
    }

    @Test
    public void resumeSessionPostsToBridgeWithAppIdHeaders() throws Exception {
        RecordedHttpCall call = serveSingleJsonResponse("{\"session\":{\"id\":\"session-2\"}}");
        try {
            new BridgeClient(call.baseUrl, "app-123").resumeSession("session-2");

            assertEquals("POST", call.method.get());
            assertEquals("/api/sessions/session-2/resume", call.path.get());
            assertEquals("Bearer app-123", call.authorization.get());
            assertEquals("app-123", call.appIdHeader.get());
        } finally {
            call.close();
        }
    }

    private static RecordedHttpCall serveSingleJsonResponse(String responseBody) throws Exception {
        RecordedHttpCall call = new RecordedHttpCall();
        call.server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        call.baseUrl = "http://127.0.0.1:" + call.server.getLocalPort();
        call.thread = new Thread(() -> {
            try (Socket socket = call.server.accept();
                 BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                 OutputStreamWriter writer = new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8)) {
                String requestLine = reader.readLine();
                if (requestLine != null) {
                    String[] parts = requestLine.split(" ");
                    call.method.set(parts[0]);
                    call.path.set(parts[1]);
                }
                String line;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {
                    String lower = line.toLowerCase(java.util.Locale.ROOT);
                    if (lower.startsWith("authorization:")) {
                        call.authorization.set(line.substring(line.indexOf(':') + 1).trim());
                    }
                    if (lower.startsWith("x-codex-app-id:")) {
                        call.appIdHeader.set(line.substring(line.indexOf(':') + 1).trim());
                    }
                }
                writer.write("HTTP/1.1 200 OK\r\n");
                writer.write("Content-Type: application/json\r\n");
                writer.write("Content-Length: " + responseBody.getBytes(StandardCharsets.UTF_8).length + "\r\n");
                writer.write("\r\n");
                writer.write(responseBody);
                writer.flush();
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        });
        call.thread.start();
        return call;
    }

    private static final class RecordedHttpCall {
        final AtomicReference<String> method = new AtomicReference<>("");
        final AtomicReference<String> path = new AtomicReference<>("");
        final AtomicReference<String> authorization = new AtomicReference<>("");
        final AtomicReference<String> appIdHeader = new AtomicReference<>("");
        ServerSocket server;
        Thread thread;
        String baseUrl;

        void close() throws Exception {
            if (thread != null) {
                thread.join(2000);
            }
            if (server != null && !server.isClosed()) {
                server.close();
            }
        }
    }
}
