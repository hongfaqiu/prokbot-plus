package org.json;

import java.util.LinkedHashMap;
import java.util.Map;

public class JSONObject {
    public static final Object NULL = new Object();
    private final Map<String, Object> map = new LinkedHashMap<>();

    public JSONObject() {}

    public JSONObject(String json) {
        String s = json == null ? "" : json.trim();
        if (!s.startsWith("{") || !s.endsWith("}")) throw new IllegalArgumentException("Bad JSONObject");
        String inner = s.substring(1, s.length() - 1).trim();
        int i = 0;
        while (i < inner.length()) {
            while (i < inner.length() && (inner.charAt(i) == ',' || Character.isWhitespace(inner.charAt(i)))) i++;
            if (i >= inner.length()) break;
            if (inner.charAt(i) != '"') throw new IllegalArgumentException("Expected string key");
            int[] next = new int[1];
            String key = readString(inner, i, next);
            i = next[0];
            while (i < inner.length() && Character.isWhitespace(inner.charAt(i))) i++;
            if (i >= inner.length() || inner.charAt(i) != ':') throw new IllegalArgumentException("Expected colon");
            i++;
            while (i < inner.length() && Character.isWhitespace(inner.charAt(i))) i++;
            if (i >= inner.length()) throw new IllegalArgumentException("Expected value");
            Object val;
            if (inner.charAt(i) == '"') {
                val = readString(inner, i, next);
                i = next[0];
            } else {
                int start = i;
                while (i < inner.length() && inner.charAt(i) != ',') i++;
                val = inner.substring(start, i).trim();
            }
            map.put(key, val);
        }
    }

    private static String readString(String src, int start, int[] outNext) {
        int i = start + 1;
        StringBuilder sb = new StringBuilder();
        while (i < src.length()) {
            char c = src.charAt(i++);
            if (c == '\\' && i < src.length()) {
                char esc = src.charAt(i++);
                if (esc == 'u' && i + 4 <= src.length()) {
                    sb.append((char) Integer.parseInt(src.substring(i, i + 4), 16));
                    i += 4;
                } else {
                    sb.append(esc);
                }
            } else if (c == '"') {
                outNext[0] = i;
                return sb.toString();
            } else {
                sb.append(c);
            }
        }
        throw new IllegalArgumentException("Unterminated string");
    }

    public JSONObject put(String name, Object value) {
        map.put(name, value);
        return this;
    }

    public String optString(String name) {
        return optString(name, "");
    }

    public String optString(String name, String fallback) {
        Object v = map.get(name);
        return v == null || v == NULL ? fallback : String.valueOf(v);
    }
}
