package dev.grokbot.local;

import android.content.Context;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

// Exercise the compiled production Pairing.verify and Pairing.pair on the JVM. Both listeners are loopback fixtures.
public final class PairingOriginProbe {
    public static void main(String[] args) throws Exception {
        AtomicInteger savedHits = new AtomicInteger(), otherHits = new AtomicInteger();
        String token = "synthetic-device-only";
        HttpServer saved = server(savedHits, token), other = server(otherHits, token);
        List<JSONObject> pairRequests = new ArrayList<>();
        AtomicInteger pairStatus = new AtomicInteger(201);
        final String[] pairResponseOverride = { null };
        HttpServer pairServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 1);
        String pairOrigin = "http://127.0.0.1:" + pairServer.getAddress().getPort();
        pairServer.createContext("/connect/pair", exchange -> {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            try (InputStream in = exchange.getRequestBody()) {
                byte[] chunk = new byte[1024];
                int n;
                while ((n = in.read(chunk)) >= 0) buf.write(chunk, 0, n);
            }
            pairRequests.add(new JSONObject(buf.toString(StandardCharsets.UTF_8)));
            int code = pairStatus.get();
            String body = pairResponseOverride[0];
            if (body == null) {
                body = code == 201
                    ? "{\"deviceId\":\"dev-1\",\"token\":\"" + token + "\",\"gatewayUrl\":\"" + pairOrigin + "\"}"
                    : code == 409
                        ? "{\"error\":\"Host is not initialized\"}"
                        : "{\"error\":\"failed\"}";
            }
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(code, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        pairServer.start();
        try {
            String origin = "http://127.0.0.1:" + saved.getAddress().getPort();
            Connection device = new Connection(origin, "fixture", token);
            Context context = new Context();
            Connection result = Pairing.INSTANCE.verify(context, origin + "/", device);
            if (!result.getDeviceId().equals(device.getDeviceId()) || savedHits.get() != 1) throw new AssertionError("same-origin retry");
            try {
                Pairing.INSTANCE.verify(context, "http://127.0.0.1:" + other.getAddress().getPort(), device);
                throw new AssertionError("changed origin accepted");
            } catch (Throwable e) {
                if (!(e instanceof PairingException) || !e.getMessage().contains("new pairing code")) throw e;
            }
            if (otherHits.get() != 0 || savedHits.get() != 1) throw new AssertionError("a changed origin received a request");

            // 1. Admin password pairing succeeds with exact password and sets android clientKind.
            Connection pwdConn = Pairing.INSTANCE.pair(context, pairOrigin + "/", "", false, null, "qqhsfa.com");
            if (!"dev-1".equals(pwdConn.getDeviceId()) || !token.equals(pwdConn.getToken()) || !pairOrigin.equals(pwdConn.getServer())) {
                throw new AssertionError("password pair returned unexpected connection");
            }
            JSONObject firstReq = pairRequests.get(0);
            if (!"qqhsfa.com".equals(firstReq.optString("password")) || !firstReq.isNull("pairingKey") || !"android".equals(firstReq.optString("clientKind"))) {
                throw new AssertionError("unexpected password pair payload: " + firstReq);
            }

            // 2. Pairing code mode still normalizes full-width/uppercase and sends pairingKey without password.
            Connection codeConn = Pairing.INSTANCE.pair(context, pairOrigin, "\uff41\uff42-\uff43\uff12\uff13\uff14", false, null, "");
            if (!"dev-1".equals(codeConn.getDeviceId())) throw new AssertionError("code pair failed");
            JSONObject secondReq = pairRequests.get(1);
            if (!"AB-C234".equals(secondReq.optString("pairingKey")) || !secondReq.isNull("password")) {
                throw new AssertionError("unexpected code pair payload: " + secondReq);
            }

            // 3. Rejects passing both pairingKey and password without contacting Host.
            int beforeConflict = pairRequests.size();
            try {
                Pairing.INSTANCE.pair(context, pairOrigin, "ABC234", false, null, "qqhsfa.com");
                throw new AssertionError("conflict accepted");
            } catch (Throwable e) {
                if (!(e instanceof PairingException) || !e.getMessage().contains("either")) throw e;
            }
            if (pairRequests.size() != beforeConflict) throw new AssertionError("conflict contacted Host");

            // 4. Rejects overly long admin password without contacting Host.
            try {
                Pairing.INSTANCE.pair(context, pairOrigin, "", false, null, "x".repeat(129));
                throw new AssertionError("long password accepted");
            } catch (Throwable e) {
                if (!(e instanceof PairingException) || !e.getMessage().contains("too long")) throw e;
            }
            if (pairRequests.size() != beforeConflict) throw new AssertionError("long password contacted Host");

            // 5. Maps 401 (password), 429, 409, and gatewayUrl mismatch cleanly.
            pairStatus.set(401);
            try {
                Pairing.INSTANCE.pair(context, pairOrigin, "", false, null, "wrong-password");
                throw new AssertionError("401 accepted");
            } catch (Throwable e) {
                if (!(e instanceof PairingException) || !e.getMessage().contains("Admin password is incorrect")) throw e;
            }
            pairStatus.set(429);
            try {
                Pairing.INSTANCE.pair(context, pairOrigin, "", false, null, "wrong-password");
                throw new AssertionError("429 accepted");
            } catch (Throwable e) {
                if (!(e instanceof PairingException) || !e.getMessage().contains("Too many")) throw e;
            }
            pairStatus.set(409);
            try {
                Pairing.INSTANCE.pair(context, pairOrigin, "", false, null, "qqhsfa.com");
                throw new AssertionError("409 accepted");
            } catch (Throwable e) {
                if (!(e instanceof PairingException) || !e.getMessage().contains("Host is not initialized")) throw e;
            }
            pairStatus.set(201);
            pairResponseOverride[0] = "{\"deviceId\":\"dev-1\",\"token\":\"" + token + "\",\"gatewayUrl\":\"https://evil.example\"}";
            try {
                Pairing.INSTANCE.pair(context, pairOrigin, "", false, null, "qqhsfa.com");
                throw new AssertionError("gateway mismatch accepted");
            } catch (Throwable e) {
                if (!(e instanceof PairingException) || !e.getMessage().contains("different server address")) throw e;
            }

            System.out.println("PASS compiled Pairing.verify + Pairing.pair: verify=1, pairRequests=" + pairRequests.size());
        } finally { saved.stop(0); other.stop(0); pairServer.stop(0); }
    }

    private static HttpServer server(AtomicInteger hits, String token) throws Exception {
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 1);
        s.createContext("/connect/status", exchange -> {
            hits.incrementAndGet();
            boolean match = ("Bearer " + token).equals(exchange.getRequestHeaders().getFirst("Authorization"));
            exchange.sendResponseHeaders(match ? 200 : 401, -1); exchange.close();
        });
        s.start(); return s;
    }
}
