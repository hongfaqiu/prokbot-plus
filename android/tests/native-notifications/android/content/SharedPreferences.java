package android.content;

import java.util.Set;

public interface SharedPreferences {
    String getString(String key, String defValue);
    Set<String> getStringSet(String key, Set<String> defValues);
    boolean getBoolean(String key, boolean defValue);
    Editor edit();

    interface Editor {
        Editor putString(String key, String value);
        Editor putStringSet(String key, Set<String> values);
        Editor putBoolean(String key, boolean value);
        Editor remove(String key);
        Editor clear();
        boolean commit();
        void apply();
    }
}
