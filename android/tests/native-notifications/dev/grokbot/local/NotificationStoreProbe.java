package dev.grokbot.local;

import android.content.Context;
import android.content.InMemorySharedPreferences;
import android.content.Intent;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

public final class NotificationStoreProbe {
    private static void need(boolean cond, String msg) {
        if (!cond) throw new AssertionError(msg);
    }

    private static void setField(Object target, String name, Object value) throws Exception {
        Field f = target.getClass().getDeclaredField(name);
        f.setAccessible(true);
        f.set(target, value);
    }

    public static void main(String[] args) throws Exception {
        Context context = new Context();
        InMemorySharedPreferences prefs = (InMemorySharedPreferences) context.getSharedPreferences("connection", Context.MODE_PRIVATE);
        prefs.edit().putString("deviceId", "dev-1").commit();
        int baseCommits = prefs.commitCount;

        ConnectionStore store = new ConnectionStore(context);

        // 1. Out-of-order / future timestamp cannot poison acceptNotification.
        need(store.acceptNotification("dev-1", "n-future", "2099-12-31T23:59:59Z"), "future item should be accepted");
        need(store.acceptNotification("dev-1", "n-normal", "2026-11-16T10:00:00Z"), "earlier timestamp must NOT be blocked");
        need(!store.acceptNotification("dev-1", "n-normal", "2026-11-16T10:00:00Z"), "duplicate id must be rejected");
        need(!store.acceptNotification("dev-1", "n-future", "2026-11-16T10:00:01Z"), "duplicate id must be rejected regardless of time");
        need("n-normal".equals(store.getNotificationCursor()), "SSE cursor must not regress on older duplicate");

        // 2. UnifiedPush (updateCursor=false) claims id in ring buffer without overwriting notificationCursor,
        //    and subsequent SSE replay deduplicates while advancing notificationCursor.
        need(store.acceptNotification("dev-1", "n-up-1", "2026-11-16T10:05:00Z", false), "UP notification should be accepted");
        need("n-normal".equals(store.getNotificationCursor()), "updateCursor=false must not overwrite SSE Last-Event-ID");
        need(!store.acceptNotification("dev-1", "n-up-1", "2026-11-16T10:05:00Z", true), "SSE replay of UP-delivered id must deduplicate");
        need("n-up-1".equals(store.getNotificationCursor()), "SSE replay must advance Last-Event-ID cursor");

        // 3. Empty createdAt is still deduplicated by ID.
        need(store.acceptNotification("dev-1", "n-empty-time", "", true), "empty time with valid id should accept once");
        need(!store.acceptNotification("dev-1", "n-empty-time", "", true), "empty time duplicate must be rejected");

        // 4. Device ID mismatch is ignored.
        need(!store.acceptNotification("other-dev", "n-wrong-dev", "2026-11-16T10:06:00Z", true), "mismatched deviceId must return false");

        // 5. Persisted atomically via commit(), not apply().
        need(prefs.commitCount > baseCommits && prefs.applyCount == 0, "notification ring buffer must persist via commit()");

        // 6. Bounded 256-entry ring buffer evicts oldest after 256 IDs.
        store.clear();
        prefs.edit().putString("deviceId", "dev-2").commit();
        for (int i = 1; i <= 256; i++) {
            need(store.acceptNotification("dev-2", "ring-" + i, "2026-11-16T10:00:00Z", true), "should accept ring-" + i);
        }
        need(!store.acceptNotification("dev-2", "ring-1", "2026-11-16T10:00:00Z", true), "ring-1 still in 256-id window");
        need(store.acceptNotification("dev-2", "ring-257", "2026-11-16T10:00:00Z", true), "should accept ring-257");
        need(!store.acceptNotification("dev-2", "ring-2", "2026-11-16T10:00:00Z", true), "ring-2 still in 256-id window");
        need(store.acceptNotification("dev-2", "ring-1", "2026-11-16T10:00:00Z", true), "ring-1 should have been evicted");

        // 7. seedNotifications seeds newest 256 IDs and sets notificationCursor.
        store.clear();
        prefs.edit().putString("deviceId", "dev-3").commit();
        JSONArray seed = new JSONArray();
        for (int i = 0; i < 300; i++) {
            seed.put(new JSONObject().put("id", "seed-" + i).put("createdAt", "2026-11-16T10:00:00Z"));
        }
        store.seedNotifications("dev-3", seed);
        need("seed-299".equals(store.getNotificationCursor()), "seedNotifications should set cursor to last item");
        need(!store.acceptNotification("dev-3", "seed-299", "", true), "seed-299 should be deduplicated");
        need(!store.acceptNotification("dev-3", "seed-44", "", true), "seed-44 (within last 256) should be deduplicated");
        need(store.acceptNotification("dev-3", "seed-0", "", true), "seed-0 (older than 256) was evicted");

        // 8. Legacy cursor state migrates cleanly without timestamp blocking.
        store.clear();
        Set<String> legacyIds = new HashSet<>();
        legacyIds.add("legacy-1");
        legacyIds.add("legacy-last");
        prefs.edit()
            .putString("deviceId", "dev-4")
            .putString("notificationCursor", "legacy-last")
            .putString("notificationCursorTime", "2099-01-01T00:00:00Z")
            .putStringSet("notificationCursorIds", legacyIds)
            .commit();
        need(!store.acceptNotification("dev-4", "legacy-1", "2026-01-01T00:00:00Z", true), "migrated legacy id must be deduplicated");
        need(store.acceptNotification("dev-4", "post-upgrade", "2026-01-01T00:00:00Z", true), "earlier time after legacy future cursor must accept");
        need(prefs.getString("notificationCursorTime", null) == null, "legacy notificationCursorTime should be cleared");

        // 9. UnifiedPushReceiver token verification + goAsync() + wakeLock lifecycle + ring-buffer claim without cursor poisoning.
        GrokBotApp app = new GrokBotApp();
        InMemorySharedPreferences connPrefs = (InMemorySharedPreferences) app.getSharedPreferences("connection", Context.MODE_PRIVATE);
        connPrefs.edit().putString("deviceId", "dev-up").putString("notificationCursor", "sse-cursor-0").commit();
        ConnectionStore appStore = new ConnectionStore(app);
        PushManager push = new PushManager(app);
        setField(app, "connections", appStore);
        setField(app, "push", push);
        app.setInForeground(true);
        app.setViewingAgentId("bot-1");
        app.setApplicationContext(app);

        // Before UnifiedPush is configured, spoofed ACTION_MESSAGE & ACTION_REGISTRATION_FAILED are rejected synchronously.
        UnifiedPushReceiver receiver = new UnifiedPushReceiver();
        Intent spoofMsgNoProvider = new Intent(UnifiedPushReceiver.ACTION_MESSAGE)
            .putExtra("message", "{\"notificationId\":\"spoof-1\",\"agentId\":\"bot-1\",\"createdAt\":\"2099-01-01T00:00:00Z\"}");
        receiver.onReceive(app, spoofMsgNoProvider);
        need(receiver.goAsyncCalls.get() == 0, "ACTION_MESSAGE must be ignored when provider != unifiedpush");
        need(appStore.acceptNotification("dev-up", "spoof-1", "", true), "spoof-1 should NOT have been claimed");
        connPrefs.edit().putString("notificationCursor", "sse-cursor-0").commit();

        Intent spoofFailNoProvider = new Intent(UnifiedPushReceiver.ACTION_REGISTRATION_FAILED)
            .putExtra("message", "forged error");
        receiver.onReceive(app, spoofFailNoProvider);
        need(receiver.goAsyncCalls.get() == 0 && push.getRegistrationError() == null, "REGISTRATION_FAILED ignored when inactive");

        // Activate UnifiedPush state in push_config prefs.
        InMemorySharedPreferences pushPrefs = (InMemorySharedPreferences) app.getSharedPreferences("push_config", Context.MODE_PRIVATE);
        pushPrefs.edit().putString("provider", "unifiedpush").putString("unifiedPushInstance", "inst-secret-123").commit();

        // Wrong token and explicit empty token extra must be rejected on ACTION_MESSAGE and ACTION_REGISTRATION_FAILED.
        receiver.onReceive(app, new Intent(UnifiedPushReceiver.ACTION_MESSAGE)
            .putExtra("token", "wrong-token")
            .putExtra("message", "{\"notificationId\":\"spoof-2\",\"agentId\":\"bot-1\"}"));
        receiver.onReceive(app, new Intent(UnifiedPushReceiver.ACTION_MESSAGE)
            .putExtra("token", "")
            .putExtra("message", "{\"notificationId\":\"spoof-3\",\"agentId\":\"bot-1\"}"));
        receiver.onReceive(app, new Intent(UnifiedPushReceiver.ACTION_REGISTRATION_FAILED)
            .putExtra("token", "wrong-token")
            .putExtra("message", "bad"));
        receiver.onReceive(app, new Intent(UnifiedPushReceiver.ACTION_REGISTRATION_FAILED)
            .putExtra("token", "")
            .putExtra("message", "bad"));
        need(receiver.goAsyncCalls.get() == 0, "mismatched or empty token extras must be dropped without goAsync");
        need(push.getRegistrationError() == null, "mismatched registration failed must not set error");

        // Valid ACTION_MESSAGE with matching token dispatches via goAsync(), acquires/releases WakeLock, claims ID without overwriting SSE cursor.
        // Note: gateway field is null, wait - set gateway or test connection via connections? Let's attach a Connection in connections?
        // UnifiedPushReceiver reads app.gateway.connection ?: app.connections.loadOrNull().
        // Let's supply LocalGateway or avoid needing LocalGateway by checking token validation + goAsync:
        // Actually we can check if LocalGateway can be constructed, or instantiate via Unsafe!
        Field unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
        unsafeField.setAccessible(true);
        sun.misc.Unsafe unsafe = (sun.misc.Unsafe) unsafeField.get(null);
        LocalGateway gateway = (LocalGateway) unsafe.allocateInstance(LocalGateway.class);
        gateway.setConnection(new Connection("https://host.example", "dev-up", "tok-1"));
        setField(app, "gateway", gateway);

        receiver.expectAsync();
        Intent validMsg = new Intent(UnifiedPushReceiver.ACTION_MESSAGE)
            .putExtra("token", "inst-secret-123")
            .putExtra("bytesMessage", "{\"notificationId\":\"up-valid-1\",\"agentId\":\"bot-1\",\"createdAt\":\"2099-05-01T00:00:00Z\"}".getBytes(StandardCharsets.UTF_8));
        receiver.onReceive(app, validMsg);
        need(receiver.awaitFinish(5000), "valid ACTION_MESSAGE must finish goAsync");
        need(receiver.goAsyncCalls.get() == 1 && receiver.finishCalls.get() == 1, "goAsync and finish counts must match");
        need(app.testPowerManager().acquires.get() == 1 && app.testPowerManager().releases.get() == 1, "WakeLock must be acquired and released");
        need("sse-cursor-0".equals(appStore.getNotificationCursor()), "ACTION_MESSAGE must not overwrite SSE notificationCursor");
        need(!appStore.acceptNotification("dev-up", "up-valid-1", "2099-05-01T00:00:00Z", true), "SSE replay of up-valid-1 must deduplicate");
        need("up-valid-1".equals(appStore.getNotificationCursor()), "SSE replay must advance cursor to up-valid-1");
        need(appStore.acceptNotification("dev-up", "legit-after-up", "2026-11-16T10:00:00Z", true), "earlier timestamp after UP future createdAt must still be accepted");

        // Valid ACTION_MESSAGE without token extra (older UnifiedPush distributor) is accepted when active,
        // and still does not overwrite SSE notificationCursor.
        receiver.expectAsync();
        Intent validMsgNoToken = new Intent(UnifiedPushReceiver.ACTION_MESSAGE)
            .putExtra("message", "{\"notificationId\":\"up-valid-no-token\",\"agentId\":\"bot-1\",\"createdAt\":\"2099-06-01T00:00:00Z\"}");
        receiver.onReceive(app, validMsgNoToken);
        need(receiver.awaitFinish(5000), "valid ACTION_MESSAGE without token must finish goAsync");
        need("legit-after-up".equals(appStore.getNotificationCursor()), "ACTION_MESSAGE without token must not overwrite SSE notificationCursor");
        need(!appStore.acceptNotification("dev-up", "up-valid-no-token", "", true), "SSE replay of up-valid-no-token must deduplicate");
        need("up-valid-no-token".equals(appStore.getNotificationCursor()), "SSE replay must advance cursor");

        // Empty bytesMessage extra must fall back to string message extra.
        receiver.expectAsync();
        Intent emptyBytesMsg = new Intent(UnifiedPushReceiver.ACTION_MESSAGE)
            .putExtra("token", "inst-secret-123")
            .putExtra("bytesMessage", new byte[0])
            .putExtra("message", "{\"notificationId\":\"up-empty-bytes\",\"agentId\":\"bot-1\"}");
        receiver.onReceive(app, emptyBytesMsg);
        need(receiver.awaitFinish(5000), "ACTION_MESSAGE with empty bytesMessage must fall back to message");
        need("up-valid-no-token".equals(appStore.getNotificationCursor()), "fallback message must not overwrite SSE cursor");
        need(!appStore.acceptNotification("dev-up", "up-empty-bytes", "", true), "fallback message must be claimed in ring buffer");

        // type == "test" via UnifiedPush must deduplicate without poisoning SSE cursor,
        // while SSE delivery of type == "test" advances SSE cursor.
        receiver.expectAsync();
        receiver.onReceive(app, new Intent(UnifiedPushReceiver.ACTION_MESSAGE)
            .putExtra("token", "inst-secret-123")
            .putExtra("message", "{\"notificationId\":\"up-test-1\",\"type\":\"test\",\"agentId\":\"bot-1\"}"));
        need(receiver.awaitFinish(5000), "UP test notification must finish goAsync");
        need("up-empty-bytes".equals(appStore.getNotificationCursor()), "UP test notification must not overwrite SSE cursor");
        need(!appStore.acceptNotification("dev-up", "up-test-1", "", true), "SSE replay of up-test-1 must deduplicate");
        need("up-test-1".equals(appStore.getNotificationCursor()), "SSE replay of test notification must advance cursor");

        Notifications.INSTANCE.deliverIncoming(
            app,
            gateway.getConnection(),
            new JSONObject().put("id", "sse-test-2").put("type", "test").put("agentId", "bot-1"),
            "sse-test-2",
            true
        );
        need("sse-test-2".equals(appStore.getNotificationCursor()), "SSE test notification must advance notificationCursor");
        need(!appStore.acceptNotification("dev-up", "sse-test-2", "", true), "SSE test notification must be persisted in seen ring buffer");

        // Valid ACTION_REGISTRATION_FAILED with matching token updates registrationError via goAsync().
        receiver.expectAsync();
        receiver.onReceive(app, new Intent(UnifiedPushReceiver.ACTION_REGISTRATION_FAILED)
            .putExtra("token", "inst-secret-123")
            .putExtra("message", "distributor offline"));
        need(receiver.awaitFinish(5000), "valid REGISTRATION_FAILED must finish goAsync");
        need("distributor offline".equals(push.getRegistrationError()), "valid REGISTRATION_FAILED should record error");
        need(app.testPowerManager().acquires.get() == 5 && app.testPowerManager().releases.get() == 5, "WakeLock must balance");

        // Empty unifiedPushInstance must be rejected even when requireToken = false.
        pushPrefs.edit().putString("unifiedPushInstance", "").commit();
        need(!push.isValidUnifiedPushBroadcast(null, false, false), "empty unifiedPushInstance must fail validation");

        System.out.println("PASS compiled ConnectionStore + UnifiedPushReceiver + PushManager JVM bytecode checks");
    }
}
