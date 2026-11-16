package android.content;

import java.util.HashMap;
import java.util.Map;

public class Intent {
    private String action;
    private final Map<String, Object> extras = new HashMap<>();

    public Intent() {}

    public Intent(String action) {
        this.action = action;
    }

    public String getAction() {
        return action;
    }

    public Intent setAction(String action) {
        this.action = action;
        return this;
    }

    public boolean hasExtra(String name) {
        return extras.containsKey(name);
    }

    public Intent putExtra(String name, String value) {
        extras.put(name, value);
        return this;
    }

    public Intent putExtra(String name, byte[] value) {
        extras.put(name, value);
        return this;
    }

    public String getStringExtra(String name) {
        Object val = extras.get(name);
        return val instanceof String ? (String) val : null;
    }

    public byte[] getByteArrayExtra(String name) {
        Object val = extras.get(name);
        return val instanceof byte[] ? (byte[]) val : null;
    }
}
