package android.content;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public class InMemorySharedPreferences implements SharedPreferences {
    public final Map<String, Object> data = new HashMap<>();
    public int commitCount = 0;
    public int applyCount = 0;

    @Override
    public String getString(String key, String defValue) {
        Object val = data.get(key);
        return val instanceof String ? (String) val : defValue;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Set<String> getStringSet(String key, Set<String> defValues) {
        Object val = data.get(key);
        return val instanceof Set<?> ? new HashSet<>((Set<String>) val) : defValues;
    }

    @Override
    public boolean getBoolean(String key, boolean defValue) {
        Object val = data.get(key);
        return val instanceof Boolean ? (Boolean) val : defValue;
    }

    @Override
    public Editor edit() {
        return new InMemoryEditor();
    }

    private final class InMemoryEditor implements Editor {
        private boolean clearAll = false;
        private final Map<String, Object> staged = new HashMap<>();
        private final Set<String> removed = new HashSet<>();

        @Override
        public Editor putString(String key, String value) {
            removed.remove(key);
            staged.put(key, value);
            return this;
        }

        @Override
        public Editor putStringSet(String key, Set<String> values) {
            removed.remove(key);
            staged.put(key, values == null ? null : new HashSet<>(values));
            return this;
        }

        @Override
        public Editor putBoolean(String key, boolean value) {
            removed.remove(key);
            staged.put(key, value);
            return this;
        }

        @Override
        public Editor remove(String key) {
            staged.remove(key);
            removed.add(key);
            return this;
        }

        @Override
        public Editor clear() {
            staged.clear();
            removed.clear();
            clearAll = true;
            return this;
        }

        @Override
        public boolean commit() {
            commitCount++;
            flush();
            return true;
        }

        @Override
        public void apply() {
            applyCount++;
            flush();
        }

        private void flush() {
            if (clearAll) data.clear();
            for (String key : removed) data.remove(key);
            for (Map.Entry<String, Object> entry : staged.entrySet()) {
                if (entry.getValue() == null) data.remove(entry.getKey());
                else data.put(entry.getKey(), entry.getValue());
            }
        }
    }
}
