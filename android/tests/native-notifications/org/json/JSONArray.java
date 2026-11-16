package org.json;

import java.util.ArrayList;
import java.util.List;

public class JSONArray {
    private final List<Object> items = new ArrayList<>();

    public JSONArray() {}

    public JSONArray(String json) {
        String s = json == null ? "" : json.trim();
        if (!s.startsWith("[") || !s.endsWith("]")) throw new IllegalArgumentException("Bad JSONArray");
        String inner = s.substring(1, s.length() - 1).trim();
        if (inner.isEmpty()) return;
        int i = 0;
        while (i < inner.length()) {
            while (i < inner.length() && (inner.charAt(i) == ',' || Character.isWhitespace(inner.charAt(i)))) i++;
            if (i >= inner.length()) break;
            if (inner.charAt(i) != '"') throw new IllegalArgumentException("Expected string element");
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < inner.length()) {
                char c = inner.charAt(i++);
                if (c == '\\' && i < inner.length()) {
                    char esc = inner.charAt(i++);
                    if (esc == 'u' && i + 4 <= inner.length()) {
                        sb.append((char) Integer.parseInt(inner.substring(i, i + 4), 16));
                        i += 4;
                    } else {
                        sb.append(esc);
                    }
                } else if (c == '"') {
                    break;
                } else {
                    sb.append(c);
                }
            }
            items.add(sb.toString());
        }
    }

    public int length() {
        return items.size();
    }

    public JSONArray put(Object value) {
        items.add(value);
        return this;
    }

    public JSONObject optJSONObject(int index) {
        if (index < 0 || index >= items.size()) return null;
        Object v = items.get(index);
        return v instanceof JSONObject ? (JSONObject) v : null;
    }

    public String optString(int index) {
        if (index < 0 || index >= items.size()) return "";
        Object v = items.get(index);
        return v == null ? "" : String.valueOf(v);
    }

    @Override
    public String toString() {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) sb.append(',');
            String s = String.valueOf(items.get(i));
            sb.append('"');
            for (int j = 0; j < s.length(); j++) {
                char c = s.charAt(j);
                if (c == '"' || c == '\\') sb.append('\\').append(c);
                else sb.append(c);
            }
            sb.append('"');
        }
        sb.append(']');
        return sb.toString();
    }
}
