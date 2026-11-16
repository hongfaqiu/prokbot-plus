package android.content;

import android.os.PowerManager;
import java.util.HashMap;
import java.util.Map;

public class Context {
    private final Map<String, InMemorySharedPreferences> prefsMap = new HashMap<>();
    private final PowerManager powerManager = new PowerManager();
    private Context applicationContext;

    public void setApplicationContext(Context app) {
        this.applicationContext = app;
    }

    public Context getApplicationContext() {
        return applicationContext != null ? applicationContext : this;
    }

    public SharedPreferences getSharedPreferences(String name, int mode) {
        return prefsMap.computeIfAbsent(name, ignored -> new InMemorySharedPreferences());
    }

    @SuppressWarnings("unchecked")
    public <T> T getSystemService(Class<T> serviceClass) {
        if (serviceClass == PowerManager.class) return (T) powerManager;
        return null;
    }

    public PowerManager testPowerManager() {
        return powerManager;
    }

    public static final int MODE_PRIVATE = 0;
}
