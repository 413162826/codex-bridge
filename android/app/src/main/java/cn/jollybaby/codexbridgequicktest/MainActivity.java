package cn.jollybaby.codexbridgequicktest;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public final class MainActivity extends Activity {
    private static final String PREFS = "codex_bridge_android";
    private static final int PORT = 4555;
    private static final int PICK_IMAGE_REQUEST = 3001;

    private final ExecutorService executor = Executors.newFixedThreadPool(32);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final List<BridgeClient.InputPart> pendingInputs = new ArrayList<>();
    private final List<String> pendingImageNames = new ArrayList<>();

    private SharedPreferences prefs;
    private EditText bridgeUrlInput;
    private EditText appIdInput;
    private EditText messageInput;
    private Button connectButton;
    private Button createKeyButton;
    private Button scanButton;
    private Button refreshSessionsButton;
    private Button newSessionButton;
    private Button attachImageButton;
    private Button clearImagesButton;
    private Button sendButton;
    private Button interruptButton;
    private TextView ipValue;
    private TextView statusValue;
    private TextView sessionValue;
    private TextView attachmentsValue;
    private LinearLayout sessionsList;
    private LinearLayout messagesList;
    private LinearLayout attachmentsList;
    private String sessionId = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        setContentView(buildContent());
        loadState();
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_IMAGE_REQUEST && resultCode == RESULT_OK && data != null && data.getData() != null) {
            uploadPickedImage(data.getData());
        }
    }

    private View buildContent() {
        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(true);
        scrollView.setBackgroundColor(Color.rgb(246, 247, 249));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(18), dp(16), dp(28));
        scrollView.addView(root, new ScrollView.LayoutParams(-1, -2));

        TextView title = text("Codex Bridge", 28, Color.rgb(18, 24, 38), Typeface.BOLD);
        root.addView(title);

        TextView subtitle = text("手机访问当前电脑 Codex", 14, Color.rgb(86, 96, 113), Typeface.NORMAL);
        subtitle.setPadding(0, dp(4), 0, dp(14));
        root.addView(subtitle);

        LinearLayout networkCard = card();
        root.addView(networkCard);
        networkCard.addView(label("连接"));

        ipValue = valueText("未获取");
        networkCard.addView(row("当前手机 IP", ipValue));

        LinearLayout networkButtons = horizontal();
        Button ipButton = primaryButton("获取 IP");
        scanButton = secondaryButton("扫描 Bridge");
        networkButtons.addView(ipButton, new LinearLayout.LayoutParams(0, dp(44), 1));
        networkButtons.addView(scanButton, new LinearLayout.LayoutParams(0, dp(44), 1));
        networkCard.addView(networkButtons);

        bridgeUrlInput = input("http://电脑局域网IP:4555");
        networkCard.addView(field("Bridge 地址 / 域名", bridgeUrlInput));

        appIdInput = input("appId");
        networkCard.addView(field("App ID", appIdInput));

        LinearLayout connectButtons = horizontal();
        connectButton = primaryButton("检查连接");
        createKeyButton = secondaryButton("创建 appId");
        connectButtons.addView(connectButton, new LinearLayout.LayoutParams(0, dp(44), 1));
        connectButtons.addView(createKeyButton, new LinearLayout.LayoutParams(0, dp(44), 1));
        networkCard.addView(connectButtons);

        statusValue = valueText("未连接");
        networkCard.addView(row("状态", statusValue));

        LinearLayout sessionCard = card();
        root.addView(sessionCard);
        sessionCard.addView(label("会话"));

        sessionValue = valueText("未选择");
        sessionCard.addView(row("当前会话", sessionValue));

        LinearLayout sessionButtons = horizontal();
        refreshSessionsButton = secondaryButton("刷新列表");
        newSessionButton = primaryButton("新对话");
        sessionButtons.addView(refreshSessionsButton, new LinearLayout.LayoutParams(0, dp(44), 1));
        sessionButtons.addView(newSessionButton, new LinearLayout.LayoutParams(0, dp(44), 1));
        sessionCard.addView(sessionButtons);

        sessionsList = new LinearLayout(this);
        sessionsList.setOrientation(LinearLayout.VERTICAL);
        sessionsList.setPadding(0, dp(8), 0, 0);
        sessionCard.addView(sessionsList);

        LinearLayout chatCard = card();
        root.addView(chatCard);
        chatCard.addView(label("聊天"));

        messageInput = input("输入消息，也可以要求 Codex 生图");
        messageInput.setMinLines(4);
        messageInput.setGravity(Gravity.TOP);
        messageInput.setSingleLine(false);
        messageInput.setImeOptions(EditorInfo.IME_ACTION_SEND);
        chatCard.addView(field("消息", messageInput));

        attachmentsValue = valueText("未附加图片");
        chatCard.addView(row("图片", attachmentsValue));

        attachmentsList = new LinearLayout(this);
        attachmentsList.setOrientation(LinearLayout.VERTICAL);
        chatCard.addView(attachmentsList);

        LinearLayout imageButtons = horizontal();
        attachImageButton = secondaryButton("选择图片");
        clearImagesButton = secondaryButton("清空图片");
        imageButtons.addView(attachImageButton, new LinearLayout.LayoutParams(0, dp(44), 1));
        imageButtons.addView(clearImagesButton, new LinearLayout.LayoutParams(0, dp(44), 1));
        chatCard.addView(imageButtons);

        LinearLayout promptButtons = horizontal();
        Button okPresetButton = secondaryButton("只回复 OK");
        Button imagePromptButton = secondaryButton("生图提示");
        promptButtons.addView(okPresetButton, new LinearLayout.LayoutParams(0, dp(44), 1));
        promptButtons.addView(imagePromptButton, new LinearLayout.LayoutParams(0, dp(44), 1));
        chatCard.addView(promptButtons);

        LinearLayout sendButtons = horizontal();
        sendButton = primaryButton("发送");
        interruptButton = secondaryButton("中断");
        sendButtons.addView(sendButton, new LinearLayout.LayoutParams(0, dp(46), 1));
        sendButtons.addView(interruptButton, new LinearLayout.LayoutParams(0, dp(46), 1));
        chatCard.addView(sendButtons);

        messagesList = new LinearLayout(this);
        messagesList.setOrientation(LinearLayout.VERTICAL);
        messagesList.setPadding(0, dp(12), 0, 0);
        chatCard.addView(messagesList);

        ipButton.setOnClickListener(v -> refreshIp());
        scanButton.setOnClickListener(v -> scanBridge());
        connectButton.setOnClickListener(v -> checkConnection());
        createKeyButton.setOnClickListener(v -> createKey());
        refreshSessionsButton.setOnClickListener(v -> refreshSessions());
        newSessionButton.setOnClickListener(v -> createNewSession());
        attachImageButton.setOnClickListener(v -> openImagePicker());
        clearImagesButton.setOnClickListener(v -> clearPendingImages());
        okPresetButton.setOnClickListener(v -> messageInput.setText("只回复 BRIDGE-OK"));
        imagePromptButton.setOnClickListener(v -> messageInput.setText("生成一张适合手机查看的简洁产品概念图，并把图片文件路径回复给我。"));
        sendButton.setOnClickListener(v -> sendMessage());
        interruptButton.setOnClickListener(v -> interruptCurrentTurn());

        return scrollView;
    }

    private void loadState() {
        bridgeUrlInput.setText(prefs.getString("bridgeUrl", ""));
        appIdInput.setText(prefs.getString("appId", ""));
        sessionId = prefs.getString("sessionId", "");
        messageInput.setText("只回复 BRIDGE-OK");
        refreshIp();
        renderAttachments();
        renderSessionPlaceholder();
        if (!sessionId.isEmpty()) {
            sessionValue.setText(shorten(sessionId));
        }
    }

    private void saveState() {
        prefs.edit()
            .putString("bridgeUrl", normalizedBridgeUrl())
            .putString("appId", appIdInput.getText().toString().trim())
            .putString("sessionId", sessionId)
            .apply();
    }

    private void refreshIp() {
        String ip = findLocalIpv4();
        ipValue.setText(ip.isEmpty() ? "未发现局域网 IPv4" : ip);
        if (!ip.isEmpty() && bridgeUrlInput.getText().toString().trim().isEmpty()) {
            String[] parts = ip.split("\\.");
            if (parts.length == 4) {
                bridgeUrlInput.setText("http://" + parts[0] + "." + parts[1] + "." + parts[2] + ".1:" + PORT);
            }
        }
    }

    private void scanBridge() {
        String ip = findLocalIpv4();
        if (ip.isEmpty()) {
            setStatus("没有可扫描的局域网 IP");
            return;
        }
        setBusy(scanButton, "扫描中...", true);
        setStatus("扫描 " + ip.substring(0, ip.lastIndexOf('.') + 1) + "1-254");
        executor.execute(() -> {
            try {
                List<String> candidates = BridgeClient.subnetCandidates(ip, PORT);
                ExecutorCompletionService<String> completion = new ExecutorCompletionService<>(executor);
                for (String candidate : candidates) {
                    completion.submit(() -> {
                        try {
                            BridgeClient client = new BridgeClient(candidate);
                            BridgeClient.HealthResult health = client.health(450);
                            return health.ok ? candidate : "";
                        } catch (Exception ignored) {
                            return "";
                        }
                    });
                }

                String found = "";
                for (int i = 0; i < candidates.size(); i++) {
                    Future<String> future = completion.take();
                    String value = future.get();
                    if (!value.isEmpty()) {
                        found = value;
                        break;
                    }
                }
                String result = found;
                runOnUi(() -> {
                    setBusy(scanButton, "扫描 Bridge", false);
                    if (result.isEmpty()) {
                        setStatus("未扫到 Bridge，请确认电脑端监听 0.0.0.0:4555");
                    } else {
                        bridgeUrlInput.setText(result);
                        saveState();
                        setStatus("发现 Bridge：" + result);
                    }
                });
            } catch (Exception error) {
                runOnUi(() -> {
                    setBusy(scanButton, "扫描 Bridge", false);
                    setStatus("扫描失败：" + error.getMessage());
                });
            }
        });
    }

    private void checkConnection() {
        String baseUrl = normalizedBridgeUrl();
        if (baseUrl.isEmpty()) {
            setStatus("先填写 Bridge 地址");
            return;
        }
        if (BridgeClient.isLoopbackHost(baseUrl)) {
            setStatus("手机不能连接电脑的 127.0.0.1，请填电脑局域网 IP 或域名");
            return;
        }
        setBusy(connectButton, "检查中...", true);
        executor.execute(() -> {
            try {
                BridgeClient.HealthResult health = client().health();
                runOnUi(() -> {
                    setBusy(connectButton, "检查连接", false);
                    setStatus(health.ok
                        ? "Bridge OK，Codex " + (health.codexStarted ? "已启动 pid " + health.pid : "未启动")
                        : "Bridge 返回异常");
                    saveState();
                    refreshSessions();
                });
            } catch (Exception error) {
                runOnUi(() -> {
                    setBusy(connectButton, "检查连接", false);
                    setStatus("连接失败：" + error.getMessage());
                });
            }
        });
    }

    private void createKey() {
        String baseUrl = normalizedBridgeUrl();
        if (baseUrl.isEmpty()) {
            setStatus("先填写 Bridge 地址");
            return;
        }
        setBusy(createKeyButton, "创建中...", true);
        executor.execute(() -> {
            try {
                String appId = new BridgeClient(baseUrl, appIdInput.getText().toString().trim()).createAppId();
                runOnUi(() -> {
                    setBusy(createKeyButton, "创建 appId", false);
                    appIdInput.setText(appId);
                    saveState();
                    copyToClipboard("appId", appId);
                    setStatus("appId 已创建并复制");
                    refreshSessions();
                });
            } catch (Exception error) {
                runOnUi(() -> {
                    setBusy(createKeyButton, "创建 appId", false);
                    setStatus("创建失败：" + error.getMessage());
                });
            }
        });
    }

    private void refreshSessions() {
        if (!ensureConfigured()) {
            return;
        }
        setBusy(refreshSessionsButton, "刷新中...", true);
        executor.execute(() -> {
            try {
                List<BridgeClient.SessionSummary> sessions = client().listSessions();
                runOnUi(() -> {
                    setBusy(refreshSessionsButton, "刷新列表", false);
                    renderSessions(sessions);
                    setStatus("会话列表已刷新：" + sessions.size() + " 个");
                    if (sessionId.isEmpty() && !sessions.isEmpty()) {
                        selectSession(sessions.get(0).id);
                    }
                });
            } catch (Exception error) {
                runOnUi(() -> {
                    setBusy(refreshSessionsButton, "刷新列表", false);
                    setStatus("刷新失败：" + error.getMessage());
                });
            }
        });
    }

    private void createNewSession() {
        if (!ensureConfigured()) {
            return;
        }
        setBusy(newSessionButton, "创建中...", true);
        executor.execute(() -> {
            try {
                String name = "手机对话 " + new SimpleDateFormat("HH:mm", Locale.CHINA).format(new Date());
                String createdId = client().createSession(appIdInput.getText().toString().trim(), name);
                runOnUi(() -> {
                    setBusy(newSessionButton, "新对话", false);
                    sessionId = createdId;
                    saveState();
                    sessionValue.setText(shorten(sessionId));
                    messagesList.removeAllViews();
                    setStatus("新对话已创建");
                    refreshSessions();
                    loadSessionDetail();
                });
            } catch (Exception error) {
                runOnUi(() -> {
                    setBusy(newSessionButton, "新对话", false);
                    setStatus("创建会话失败：" + error.getMessage());
                });
            }
        });
    }

    private void selectSession(String id) {
        sessionId = id == null ? "" : id;
        sessionValue.setText(sessionId.isEmpty() ? "未选择" : shorten(sessionId));
        saveState();
        loadSessionDetail();
    }

    private void loadSessionDetail() {
        if (sessionId.isEmpty() || !ensureConfigured()) {
            return;
        }
        executor.execute(() -> {
            try {
                BridgeClient.SessionDetail detail = client().getSession(sessionId);
                runOnUi(() -> {
                    sessionValue.setText((detail.name == null || detail.name.isEmpty() ? shorten(detail.id) : detail.name) + " · " + detail.status);
                    renderMessages(detail.messages);
                });
            } catch (Exception error) {
                runOnUi(() -> setStatus("读取会话失败：" + error.getMessage()));
            }
        });
    }

    private void sendMessage() {
        String text = messageInput.getText().toString().trim();
        if (!ensureConfigured()) {
            return;
        }
        if (text.isEmpty() && pendingInputs.isEmpty()) {
            setStatus("先输入消息或选择图片");
            return;
        }
        saveState();
        addMessageBubble("我", text.isEmpty() ? "[图片]" : text, true, Collections.emptyList());
        setBusy(sendButton, "发送中...", true);
        List<BridgeClient.InputPart> images = new ArrayList<>(pendingInputs);
        executor.execute(() -> {
            try {
                BridgeClient bridge = client();
                if (sessionId.isEmpty()) {
                    sessionId = bridge.createSession(appIdInput.getText().toString().trim(), "手机对话");
                } else {
                    bridge.resumeSession(sessionId);
                }
                String reply = bridge.sendTurnWait(sessionId, text, images);
                runOnUi(() -> {
                    setBusy(sendButton, "发送", false);
                    sessionValue.setText(shorten(sessionId));
                    messageInput.setText("");
                    clearPendingImages();
                    saveState();
                    if (reply == null || reply.trim().isEmpty()) {
                        loadSessionDetail();
                    } else {
                        addMessageBubble("Codex", reply, false, imageUrlsForReply(reply));
                    }
                    setStatus("回复完成");
                    refreshSessions();
                });
            } catch (Exception error) {
                runOnUi(() -> {
                    setBusy(sendButton, "发送", false);
                    setStatus("发送失败：" + error.getMessage());
                    addMessageBubble("错误", error.getMessage(), false, Collections.emptyList());
                });
            }
        });
    }

    private void interruptCurrentTurn() {
        if (!ensureConfigured()) {
            return;
        }
        if (sessionId.isEmpty()) {
            setStatus("当前没有可中断的会话");
            return;
        }
        setBusy(interruptButton, "中断中...", true);
        executor.execute(() -> {
            try {
                client().interruptSession(sessionId);
                runOnUi(() -> {
                    setBusy(interruptButton, "中断", false);
                    setStatus("已发送中断请求");
                    loadSessionDetail();
                });
            } catch (Exception error) {
                runOnUi(() -> {
                    setBusy(interruptButton, "中断", false);
                    setStatus("中断失败：" + error.getMessage());
                });
            }
        });
    }

    private void openImagePicker() {
        if (!ensureConfigured()) {
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        startActivityForResult(intent, PICK_IMAGE_REQUEST);
    }

    private void uploadPickedImage(Uri uri) {
        setBusy(attachImageButton, "上传中...", true);
        setStatus("上传图片到电脑工作区");
        executor.execute(() -> {
            try {
                byte[] bytes = readAllBytes(uri);
                String mimeType = getContentResolver().getType(uri);
                String fileName = guessFileName(uri, mimeType);
                String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                BridgeClient.UploadResult upload = client().uploadImage(appIdInput.getText().toString().trim(), fileName, mimeType, base64);
                runOnUi(() -> {
                    setBusy(attachImageButton, "选择图片", false);
                    pendingInputs.add(upload.inputPart);
                    pendingImageNames.add(upload.fileName + " · " + formatBytes(upload.size));
                    renderAttachments();
                    setStatus("图片已附加：" + upload.fileName);
                });
            } catch (Exception error) {
                runOnUi(() -> {
                    setBusy(attachImageButton, "选择图片", false);
                    setStatus("图片上传失败：" + error.getMessage());
                });
            }
        });
    }

    private void clearPendingImages() {
        pendingInputs.clear();
        pendingImageNames.clear();
        renderAttachments();
    }

    private List<String> imageUrlsForReply(String text) {
        List<String> urls = new ArrayList<>(BridgeClient.extractImageUrls(text));
        for (String localPath : BridgeClient.extractLocalImagePaths(text)) {
            urls.add(BridgeClient.sessionFileUrl(normalizedBridgeUrl(), sessionId, localPath));
        }
        return urls;
    }

    private void renderSessions(List<BridgeClient.SessionSummary> sessions) {
        sessionsList.removeAllViews();
        if (sessions.isEmpty()) {
            sessionsList.addView(helperText("还没有会话，点击“新对话”开始。"));
            return;
        }
        for (BridgeClient.SessionSummary session : sessions) {
            Button button = secondaryButton(session.name + "\n" + session.status + " · " + session.messageCount + " 条 · " + safePreview(session.lastMessageText));
            button.setGravity(Gravity.LEFT | Gravity.CENTER_VERTICAL);
            button.setAllCaps(false);
            button.setOnClickListener(v -> selectSession(session.id));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, dp(64));
            lp.setMargins(0, dp(8), 0, 0);
            sessionsList.addView(button, lp);
        }
    }

    private void renderMessages(List<BridgeClient.ChatMessage> messages) {
        messagesList.removeAllViews();
        if (messages.isEmpty()) {
            messagesList.addView(helperText("这段对话还没有消息。"));
            return;
        }
        for (BridgeClient.ChatMessage message : messages) {
            List<String> urls = new ArrayList<>(message.imageUrls);
            for (String localPath : message.localImagePaths) {
                urls.add(BridgeClient.sessionFileUrl(normalizedBridgeUrl(), sessionId, localPath));
            }
            addMessageBubble("assistant".equals(message.role) ? "Codex" : "我", message.text, "user".equals(message.role), urls);
        }
    }

    private void renderAttachments() {
        attachmentsList.removeAllViews();
        if (pendingImageNames.isEmpty()) {
            attachmentsValue.setText("未附加图片");
            return;
        }
        attachmentsValue.setText(pendingImageNames.size() + " 张待发送");
        for (String name : pendingImageNames) {
            attachmentsList.addView(helperText(name));
        }
    }

    private void renderSessionPlaceholder() {
        sessionsList.removeAllViews();
        sessionsList.addView(helperText("连接成功后可刷新会话列表。"));
    }

    private void addMessageBubble(String role, String textValue, boolean mine, List<String> imageUrls) {
        LinearLayout bubble = new LinearLayout(this);
        bubble.setOrientation(LinearLayout.VERTICAL);
        bubble.setPadding(dp(12), dp(10), dp(12), dp(10));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(mine ? Color.rgb(32, 39, 55) : Color.rgb(239, 243, 248));
        bg.setCornerRadius(dp(10));
        bubble.setBackground(bg);

        TextView roleView = text(role, 12, mine ? Color.rgb(221, 226, 235) : Color.rgb(92, 103, 121), Typeface.BOLD);
        bubble.addView(roleView);

        TextView body = text(textValue == null || textValue.trim().isEmpty() ? "(空)" : textValue, 15, mine ? Color.WHITE : Color.rgb(18, 24, 38), Typeface.NORMAL);
        body.setPadding(0, dp(4), 0, 0);
        bubble.addView(body);

        for (String url : imageUrls) {
            ImageView image = new ImageView(this);
            image.setAdjustViewBounds(true);
            image.setScaleType(ImageView.ScaleType.CENTER_CROP);
            GradientDrawable imageBg = new GradientDrawable();
            imageBg.setColor(Color.rgb(224, 230, 238));
            imageBg.setCornerRadius(dp(8));
            image.setBackground(imageBg);
            LinearLayout.LayoutParams imageLp = new LinearLayout.LayoutParams(-1, dp(220));
            imageLp.setMargins(0, dp(10), 0, 0);
            bubble.addView(image, imageLp);
            loadImageInto(image, url);
        }

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.setMargins(mine ? dp(28) : 0, dp(8), mine ? 0 : dp(28), 0);
        messagesList.addView(bubble, lp);
    }

    private void loadImageInto(ImageView imageView, String imageUrl) {
        executor.execute(() -> {
            try {
                Bitmap bitmap = downloadBitmap(imageUrl);
                runOnUi(() -> imageView.setImageBitmap(bitmap));
            } catch (Exception error) {
                runOnUi(() -> imageView.setContentDescription("图片加载失败：" + error.getMessage()));
            }
        });
    }

    private Bitmap downloadBitmap(String imageUrl) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(imageUrl).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setRequestProperty("User-Agent", BridgeClient.USER_AGENT);
        String appId = appIdInput.getText().toString().trim();
        if (!appId.isEmpty() && imageUrl.startsWith(normalizedBridgeUrl())) {
            connection.setRequestProperty("Authorization", "Bearer " + appId);
            connection.setRequestProperty("X-Codex-App-Id", appId);
        }
        int code = connection.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new IllegalStateException("HTTP " + code);
        }
        try (InputStream stream = connection.getInputStream()) {
            Bitmap bitmap = BitmapFactory.decodeStream(stream);
            if (bitmap == null) {
                throw new IllegalStateException("无法解析图片");
            }
            return bitmap;
        }
    }

    private byte[] readAllBytes(Uri uri) throws Exception {
        try (InputStream stream = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (stream == null) {
                throw new IllegalStateException("无法读取图片");
            }
            byte[] buffer = new byte[8192];
            int read;
            while ((read = stream.read(buffer)) >= 0) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private String guessFileName(Uri uri, String mimeType) {
        String last = uri.getLastPathSegment();
        String extension = ".png";
        if ("image/jpeg".equalsIgnoreCase(mimeType)) {
            extension = ".jpg";
        } else if ("image/webp".equalsIgnoreCase(mimeType)) {
            extension = ".webp";
        } else if ("image/gif".equalsIgnoreCase(mimeType)) {
            extension = ".gif";
        }
        if (last == null || last.trim().isEmpty()) {
            return "phone-image" + extension;
        }
        String clean = last.replaceAll("[^a-zA-Z0-9._-]+", "-");
        return clean.contains(".") ? clean : clean + extension;
    }

    private boolean ensureConfigured() {
        if (normalizedBridgeUrl().isEmpty()) {
            setStatus("先填写 Bridge 地址");
            return false;
        }
        if (BridgeClient.isLoopbackHost(normalizedBridgeUrl())) {
            setStatus("手机不能连接电脑的 127.0.0.1，请填电脑局域网 IP 或域名");
            return false;
        }
        if (appIdInput.getText().toString().trim().isEmpty()) {
            setStatus("先填写 appId");
            return false;
        }
        return true;
    }

    private BridgeClient client() {
        return new BridgeClient(normalizedBridgeUrl(), appIdInput.getText().toString().trim());
    }

    private String normalizedBridgeUrl() {
        return BridgeClient.normalizeBaseUrl(bridgeUrlInput.getText().toString());
    }

    private String findLocalIpv4() {
        try {
            List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface item : interfaces) {
                if (!item.isUp() || item.isLoopback()) {
                    continue;
                }
                for (java.net.InetAddress address : Collections.list(item.getInetAddresses())) {
                    if (address instanceof Inet4Address && !address.isLoopbackAddress()) {
                        return address.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
            return "";
        }
        return "";
    }

    private LinearLayout card() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(16), dp(16), dp(16), dp(16));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setCornerRadius(dp(8));
        bg.setStroke(dp(1), Color.rgb(224, 229, 236));
        layout.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.setMargins(0, 0, 0, dp(12));
        layout.setLayoutParams(lp);
        return layout;
    }

    private TextView label(String value) {
        TextView view = text(value, 13, Color.rgb(75, 89, 110), Typeface.BOLD);
        view.setPadding(0, 0, 0, dp(10));
        return view;
    }

    private LinearLayout row(String name, TextView value) {
        LinearLayout row = horizontal();
        TextView left = text(name, 13, Color.rgb(101, 113, 132), Typeface.NORMAL);
        row.addView(left, new LinearLayout.LayoutParams(0, -2, 1));
        row.addView(value, new LinearLayout.LayoutParams(0, -2, 1.6f));
        row.setPadding(0, dp(8), 0, dp(8));
        return row;
    }

    private LinearLayout field(String name, EditText input) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(0, dp(8), 0, dp(10));
        box.addView(text(name, 13, Color.rgb(101, 113, 132), Typeface.BOLD));
        box.addView(input, new LinearLayout.LayoutParams(-1, -2));
        return box;
    }

    private LinearLayout horizontal() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(4), 0, dp(4));
        return row;
    }

    private EditText input(String hint) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setTextSize(15);
        input.setSingleLine(true);
        input.setPadding(dp(12), 0, dp(12), 0);
        input.setMinHeight(dp(46));
        input.setTextColor(Color.rgb(18, 24, 38));
        input.setHintTextColor(Color.rgb(145, 155, 170));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.rgb(250, 252, 255));
        bg.setCornerRadius(dp(8));
        bg.setStroke(dp(1), Color.rgb(218, 224, 233));
        input.setBackground(bg);
        return input;
    }

    private Button primaryButton(String value) {
        return button(value, Color.rgb(28, 70, 142), Color.WHITE);
    }

    private Button secondaryButton(String value) {
        return button(value, Color.rgb(243, 246, 250), Color.rgb(22, 31, 48));
    }

    private Button button(String value, int background, int foreground) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextSize(14);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setTextColor(foreground);
        button.setAllCaps(false);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(background);
        bg.setCornerRadius(dp(8));
        bg.setStroke(dp(1), Color.rgb(213, 221, 232));
        button.setBackground(bg);
        return button;
    }

    private TextView valueText(String value) {
        TextView view = text(value, 13, Color.rgb(18, 24, 38), Typeface.BOLD);
        view.setGravity(Gravity.RIGHT);
        return view;
    }

    private TextView helperText(String value) {
        TextView view = text(value, 13, Color.rgb(101, 113, 132), Typeface.NORMAL);
        view.setPadding(dp(10), dp(8), dp(10), dp(8));
        return view;
    }

    private TextView text(String value, int sp, int color, int style) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setTypeface(Typeface.DEFAULT, style);
        view.setLineSpacing(0, 1.14f);
        return view;
    }

    private void setBusy(Button button, String value, boolean busy) {
        button.setEnabled(!busy);
        button.setText(value);
    }

    private void setStatus(String value) {
        statusValue.setText(value);
    }

    private void copyToClipboard(String label, String value) {
        ClipboardManager manager = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (manager != null && value != null && !value.isEmpty()) {
            manager.setPrimaryClip(ClipData.newPlainText(label, value));
            Toast.makeText(this, "已复制", Toast.LENGTH_SHORT).show();
        }
    }

    private void runOnUi(Runnable runnable) {
        mainHandler.post(runnable);
    }

    private String shorten(String value) {
        if (value == null || value.length() <= 12) {
            return value == null ? "" : value;
        }
        return value.substring(0, 8) + "..." + value.substring(value.length() - 4);
    }

    private String safePreview(String value) {
        String text = value == null ? "" : value.trim().replace('\n', ' ');
        if (text.isEmpty()) {
            return "无最近消息";
        }
        return text.length() > 34 ? text.substring(0, 34) + "..." : text;
    }

    private String formatBytes(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        }
        if (bytes < 1024 * 1024) {
            return (bytes / 1024) + " KB";
        }
        return String.format(Locale.CHINA, "%.1f MB", bytes / 1024f / 1024f);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
