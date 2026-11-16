package org.json;

import java.util.LinkedHashMap;
import java.util.Map;

public class JSONObject {
    public static final Object NULL = new Object() {
        @Override public String toString() { return "null"; }
        @Override public boolean equals(Object o) { return o == this || o == null; }
    };
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
                String raw = inner.substring(start, i).trim();
                if ("null".equals(raw)) val = NULL;
                else if ("true".equals(raw)) val = Boolean.TRUE;
                else if ("false".equals(raw)) val = Boolean.FALSE;
                else val = raw;
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
                } else if (esc == 'n') sb.append('\n');
                else if (esc == 'r') sb.append('\r');
                else if (esc == 't') sb.append('\t');
                else sb.append(esc);
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
        map.put(name, value == null ? NULL : value);
        return this;
    }

    public boolean isNull(String name) {
        Object v = map.get(name);
        return v == null || v == NULL;
    }

    public boolean optBoolean(String name) { return optBoolean(name, false); }

    public boolean optBoolean(String name, boolean fallback) {
        Object v = map.get(name);
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof String) return Boolean.parseBoolean((String) v);
        return fallback;
    }

    public String optString(String name) {
        return optString(name, "");
    }

    public String optString(String name, String fallback) {
        Object v = map.get(name);
        return v == null ? fallback : String.valueOf(v);
    }

    private static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c == '\n') sb.append("\\n");
            else if (c == '\r') sb.append("\\r");
            else if (c == '\t') sb.append("\\t");
            else sb.append(c);
        }
        return sb.append('"').toString();
    }

    @Override
    public String toString() {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append(quote(e.getKey())).append(':');
            Object v = e.getValue();
            if (v == null || v == NULL) sb.append("null");
            else if (v instanceof Boolean || v instanceof Number) sb.append(v);
            else sb.append(quote(String.valueOf(v)));
        }
        return sb.append('}').toString();
    }
}
