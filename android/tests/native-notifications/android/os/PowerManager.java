package android.os;

import java.util.concurrent.atomic.AtomicInteger;

public class PowerManager {
    public static final int PARTIAL_WAKE_LOCK = 1;
    public final AtomicInteger acquires = new AtomicInteger();
    public final AtomicInteger releases = new AtomicInteger();

    public WakeLock newWakeLock(int levelAndFlags, String tag) {
        return new WakeLock();
    }

    public final class WakeLock {
        private volatile boolean held = false;

        public void acquire(long timeout) {
            held = true;
            acquires.incrementAndGet();
        }

        public boolean isHeld() {
            return held;
        }

        public void release() {
            if (held) {
                held = false;
                releases.incrementAndGet();
            }
        }
    }
}
